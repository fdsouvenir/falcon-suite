import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { provision, type Provision } from './cli.js';
import type { Provider } from './model.js';
import { PublicError } from './providers/types.js';

export type CallbackConfig = {
	url: string;
	office: string;
	token_file: string;
	version: string;
};
export function callbackConfig(dir: string): CallbackConfig | undefined {
	const config = provision(dir).callback;
	if (!config) return undefined;
	const url = new URL(config.url);
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash ||
		!/^[A-Za-z0-9_.:-]{1,128}$/.test(config.office) ||
		!/^\d+\.\d+\.\d+$/.test(config.version) ||
		!config.token_file.startsWith('/')
	)
		throw new Error('Callback service setup is invalid.');
	return config;
}
export function callbackURI(config: CallbackConfig, provider: Provider) {
	return new URL(`/oauth2/callback/${provider}`, config.url).href;
}
export function microsoftAuthority(p: Provision) {
	return `https://login.microsoftonline.com/${p.microsoft_tenant || 'common'}/oauth2/v2.0`;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Every failure here names the sign-in return service, so a provider's earlier stage label
// (for example its permission check) is never reported for a callback problem.
const unreachable = () =>
	new PublicError(
		'callback_unreachable',
		'The sign-in return service could not be reached from this Office. Try again, or contact your administrator.'
	);
async function reach(url: URL, init: RequestInit) {
	try {
		return await fetch(url, init);
	} catch {
		throw unreachable();
	}
}
async function request(
	config: CallbackConfig,
	route: string,
	token: string,
	method: string,
	body?: unknown
) {
	const response = await reach(new URL(route, config.url), {
		method,
		redirect: 'error',
		signal: AbortSignal.timeout(15000),
		headers: {
			Authorization: `Bearer ${token}`,
			'X-Link-Office': config.office,
			'Content-Type': 'application/json'
		},
		...(body ? { body: JSON.stringify(body) } : {})
	});
	// The service keeps one session per OAuth state; a second registration of the same state
	// is refused until the first is cancelled, finished or expired.
	if (response.status === 409)
		throw new PublicError(
			'callback_session_exists',
			'The sign-in return service still holds an earlier sign-in for this request. Wait a minute, then try again.'
		);
	if (!response.ok)
		throw new PublicError(
			'callback_unavailable',
			'The sign-in return service refused this request. Try again, or contact your administrator.'
		);
	const text = await response.text();
	if (text.length > 32768)
		throw new PublicError('callback_invalid', 'The sign-in return service gave an invalid answer.');
	return { status: response.status, data: JSON.parse(text) };
}
export class CallbackHandoff {
	private constructor(
		readonly config: CallbackConfig,
		readonly id: string,
		readonly state: string,
		readonly provider: Provider,
		private readonly pollToken: string,
		private readonly privateKey: webcrypto.CryptoKey
	) {}
	static async create(config: CallbackConfig, provider: Provider, state: string) {
		const health = await reach(new URL('/health', config.url), {
			redirect: 'error',
			signal: AbortSignal.timeout(15000)
		});
		const info = (await health.json().catch(() => ({}))) as {
			version?: string;
			protocol?: number;
		};
		if (!health.ok || info.version !== config.version || info.protocol !== 1)
			throw new PublicError(
				'callback_version_mismatch',
				'The sign-in return service does not match the release this Office is set up for. Contact your administrator.'
			);
		let token = '';
		try {
			token = readFileSync(config.token_file, 'utf8').trim();
		} catch {}
		if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
			throw new PublicError(
				'callback_credentials_invalid',
				"This Office's sign-in return service credentials are missing or invalid. Contact your administrator."
			);
		const keys = await webcrypto.subtle.generateKey(
			{
				name: 'RSA-OAEP',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256'
			},
			false,
			['encrypt', 'decrypt']
		);
		const pollToken = randomBytes(32).toString('base64url');
		const { data } = await request(config, '/v1/sessions', token, 'POST', {
			provider,
			state,
			poll_hash: hash(pollToken),
			public_key: await webcrypto.subtle.exportKey('jwk', keys.publicKey)
		});
		if (data.id !== hash(state) || data.protocol !== 1 || data.expires_in !== 600)
			throw new PublicError(
				'callback_session_invalid',
				'The sign-in return service registered this sign-in incorrectly. Try again, or contact your administrator.'
			);
		return new CallbackHandoff(config, data.id, state, provider, pollToken, keys.privateKey);
	}
	async consume(): Promise<{ code?: string; error?: string } | null> {
		const { status, data } = await request(
			this.config,
			`/v1/sessions/${this.id}`,
			this.pollToken,
			'POST'
		);
		if (status === 202) return null;
		const key = await webcrypto.subtle.decrypt(
			'RSA-OAEP',
			this.privateKey,
			Buffer.from(data.key, 'base64')
		);
		const aes = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
		const plain = await webcrypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: Buffer.from(data.iv, 'base64') },
			aes,
			Buffer.from(data.ciphertext, 'base64')
		);
		const result = JSON.parse(Buffer.from(plain).toString('utf8'));
		if (
			result.state !== this.state ||
			result.provider !== this.provider ||
			(!result.code && !result.error)
		)
			throw new Error('Callback session did not match this sign-in.');
		return result;
	}
	async cancel() {
		await request(this.config, `/v1/sessions/${this.id}`, this.pollToken, 'DELETE');
	}
}
