import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { provision, type Provision } from './cli.js';
import type { Provider } from './model.js';

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
export function microsoftAuthority(p: Provision, audience: string) {
	return `https://login.microsoftonline.com/${audience === 'consumer' ? 'consumers' : p.microsoft_tenant || 'organizations'}/oauth2/v2.0`;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function request(
	config: CallbackConfig,
	route: string,
	token: string,
	method: string,
	body?: unknown
) {
	const response = await fetch(new URL(route, config.url), {
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
	if (!response.ok)
		throw new Error(
			'The callback service is unavailable. Start a new sign-in or contact your administrator.'
		);
	const text = await response.text();
	if (text.length > 32768) throw new Error('Invalid callback response.');
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
		const health = await fetch(new URL('/health', config.url), {
			redirect: 'error',
			signal: AbortSignal.timeout(15000)
		});
		const info = (await health.json()) as { version?: string; protocol?: number };
		if (!health.ok || info.version !== config.version || info.protocol !== 1)
			throw new Error('The callback service version does not match the configured release.');
		const token = readFileSync(config.token_file, 'utf8').trim();
		if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
			throw new Error('Callback service credentials are invalid.');
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
			throw new Error('Invalid callback session.');
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
