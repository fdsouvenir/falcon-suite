import { DurableObject } from 'cloudflare:workers';

// Kept in step with package.json; /health and deployment metadata identify the artifact.
const VERSION = '0.1.0';
const TTL = 10 * 60 * 1000;
const headers = {
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};
function reply(value: unknown, status = 200) {
	return Response.json(value, { status, headers });
}
async function digest(value: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
		(b) => b.toString(16).padStart(2, '0')
	).join('');
}
function b64(bytes: ArrayBuffer | Uint8Array) {
	return btoa(
		String.fromCharCode(
			...new Uint8Array(bytes instanceof Uint8Array ? (bytes.buffer as ArrayBuffer) : bytes)
		)
	);
}
export type SessionInput = {
	provider: 'google' | 'microsoft';
	state: string;
	poll_hash: string;
	public_key: JsonWebKey;
};
export type SessionRecord = SessionInput & {
	office: string;
	expires: number;
	consumed?: boolean;
	result?: { key: string; iv: string; ciphertext: string };
};
async function seal(publicKey: JsonWebKey, data: unknown) {
	const recipient = await crypto.subtle.importKey(
		'jwk',
		publicKey,
		{ name: 'RSA-OAEP', hash: 'SHA-256' },
		false,
		['encrypt']
	);
	const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	return {
		key: b64(
			await crypto.subtle.encrypt('RSA-OAEP', recipient, await crypto.subtle.exportKey('raw', key))
		),
		iv: b64(iv),
		ciphertext: b64(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				key,
				new TextEncoder().encode(JSON.stringify(data))
			)
		)
	};
}

export class CallbackSession extends DurableObject<Env> {
	async create(input: SessionInput, office: string) {
		if (this.ctx.storage.kv.get('session')) return false;
		this.ctx.storage.kv.put('session', {
			...input,
			office,
			expires: Date.now() + TTL
		} satisfies SessionRecord);
		await this.ctx.storage.setAlarm(Date.now() + TTL);
		return true;
	}
	async callback(provider: string, code: string | null, denied: boolean) {
		const session = this.ctx.storage.kv.get<SessionRecord>('session');
		if (
			!session ||
			session.expires <= Date.now() ||
			session.provider !== provider ||
			session.consumed ||
			session.result
		)
			return false;
		// Cryptography yields: re-read before committing to reject racing callbacks/cancellation.
		const result = await seal(session.public_key, {
			state: session.state,
			provider,
			...(denied ? { error: 'consent_not_completed' } : { code })
		});
		const current = this.ctx.storage.kv.get<SessionRecord>('session');
		if (!current || current.consumed || current.result || current.expires <= Date.now())
			return false;
		this.ctx.storage.kv.put('session', { ...current, result });
		return true;
	}
	consume(pollHash: string, cancel: boolean) {
		const session = this.ctx.storage.kv.get<SessionRecord>('session');
		if (
			!session ||
			session.expires <= Date.now() ||
			session.poll_hash !== pollHash ||
			session.consumed
		)
			return reply({ error: 'session_unavailable' }, 404);
		if (cancel || session.result) {
			// One synchronous transaction: competing consumers cannot receive the same result.
			this.ctx.storage.kv.put('session', {
				...session,
				public_key: {},
				result: undefined,
				consumed: true
			});
			return reply(cancel ? { cancelled: true } : session.result);
		}
		return reply({ pending: true }, 202);
	}
	async alarm() {
		await this.ctx.storage.deleteAll();
	}
}

async function boundedJSON(request: Request): Promise<unknown> {
	if (!request.headers.get('Content-Type')?.startsWith('application/json'))
		throw new Error('content_type');
	const reader = request.body?.getReader();
	if (!reader) throw new Error('body');
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 16384) {
			await reader.cancel();
			throw new Error('body_size');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === 'GET' && url.pathname === '/health')
				return reply({ name: 'Link Callback Worker', version: VERSION, protocol: 1 });
			if (request.method === 'POST' && url.pathname === '/v1/sessions') {
				// Private per-Office tokens; disabling one Office does not affect the fleet.
				const office = request.headers.get('X-Link-Office') ?? '';
				const offices: Record<string, string> = JSON.parse(env.OFFICE_KEYS_JSON);
				const token = request.headers
					.get('Authorization')
					?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
				if (!Object.hasOwn(offices, office) || !token || (await digest(token)) !== offices[office])
					return reply({ error: 'unauthorized' }, 401);
				const input = (await boundedJSON(request)) as SessionInput;
				if (
					!['google', 'microsoft'].includes(input.provider) ||
					!/^[A-Za-z0-9_-]{16,256}$/.test(input.state) ||
					!/^[a-f0-9]{64}$/.test(input.poll_hash) ||
					input.public_key?.kty !== 'RSA' ||
					input.public_key.d ||
					(input.public_key.n?.length ?? 0) < 342 ||
					(input.public_key.n?.length ?? 0) > 684 ||
					input.public_key.e !== 'AQAB'
				)
					return reply({ error: 'invalid_session' }, 400);
				await crypto.subtle.importKey(
					'jwk',
					input.public_key,
					{ name: 'RSA-OAEP', hash: 'SHA-256' },
					false,
					['encrypt']
				);
				const id = await digest(input.state);
				const created = await env.SESSIONS.getByName(id).create(
					{
						provider: input.provider,
						state: input.state,
						poll_hash: input.poll_hash,
						public_key: input.public_key
					},
					office
				);
				return created
					? reply({ id, expires_in: TTL / 1000, protocol: 1 }, 201)
					: reply({ error: 'session_exists' }, 409);
			}
			const callback = url.pathname.match(/^\/oauth2\/callback\/(google|microsoft)$/);
			if (request.method === 'GET' && callback) {
				const state = url.searchParams.get('state') ?? '';
				const code = url.searchParams.get('code');
				if (
					!/^[A-Za-z0-9_-]{16,256}$/.test(state) ||
					url.searchParams.getAll('state').length !== 1 ||
					url.searchParams.getAll('code').length > 1 ||
					(!code && !url.searchParams.has('error')) ||
					(code?.length ?? 0) > 8192
				)
					return reply({ error: 'invalid_callback' }, 400);
				const accepted = await env.SESSIONS.getByName(await digest(state)).callback(
					callback[1],
					code,
					url.searchParams.has('error')
				);
				return new Response(
					accepted
						? 'Sign-in received. Return to your Office to finish connecting. You can close this tab.'
						: 'This sign-in is unavailable or expired. Return to your Office and start again.',
					{
						status: accepted ? 200 : 400,
						headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }
					}
				);
			}
			const session = url.pathname.match(/^\/v1\/sessions\/([a-f0-9]{64})$/);
			if (session && ['POST', 'DELETE'].includes(request.method)) {
				const token = request.headers
					.get('Authorization')
					?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
				if (!token) return reply({ error: 'session_unavailable' }, 404);
				return await env.SESSIONS.getByName(session[1]).consume(
					await digest(token),
					request.method === 'DELETE'
				);
			}
			return reply({ error: 'not_found' }, 404);
		} catch {
			// Never log request URLs, codes, bodies, provider diagnostics or credentials.
			console.error(JSON.stringify({ event: 'callback_request_failed', version: VERSION }));
			return reply({ error: 'request_failed' }, 400);
		}
	}
} satisfies ExportedHandler<Env>;
