import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { LinkService } from '../dist/service.js';
import { CallbackHandoff } from '../dist/callback.js';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const b64 = (v) => Buffer.from(v).toString('base64');
async function scenario(run) {
	const dir = await mkdtemp(path.join(tmpdir(), 'link-hosted-'));
	const oldFetch = globalThis.fetch,
		oldKey = process.env.FALCON_LINK_KEYRING_PASSWORD;
	const sessions = new Map();
	let attempts = 0;
	try {
		process.env.FALCON_LINK_KEYRING_PASSWORD = 'fixture-only';
		const token = randomBytes(32).toString('base64url'),
			tokenFile = path.join(dir, 'callback-token');
		await writeFile(tokenFile, token, { mode: 0o600 });
		const credentials = path.join(dir, 'google.json');
		await writeFile(
			credentials,
			JSON.stringify({ web: { client_id: 'fixture-client', client_secret: 'fixture-secret' } }),
			{ mode: 0o600 }
		);
		await writeFile(
			path.join(dir, 'provision.json'),
			JSON.stringify({
				google_credentials_file: credentials,
				microsoft_client_id: '00000000-0000-0000-0000-000000000001',
				callback: {
					url: 'https://callback.example',
					office: 'bravo',
					token_file: tokenFile,
					version: '0.1.0'
				}
			})
		);
		for (const [provider, version, binary] of [
			['google', '0.47.0', 'gog'],
			['microsoft', '2.0.0', 'm365cli']
		]) {
			const folder = path.join(dir, 'tools', provider, version);
			await mkdir(folder, { recursive: true });
			await writeFile(
				path.join(folder, binary),
				`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(a[0]==='--version'){console.log('${version}');process.exit();}
if(a.includes('credentials'))send({saved:true});
else if(a.includes('--step')&&a[a.indexOf('--step')+1]==='1'){
const u=new URL('https://accounts.google.com/o/oauth2/auth');u.search=new URLSearchParams({state:'local-state-01234567890123456789',redirect_uri:a[a.indexOf('--redirect-uri')+1],scope:'openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly'}).toString();send({auth_url:u.href});
}else if(a.includes('--step')){fs.writeFileSync(path.join(process.env.HOME,'identity'),a[2]);send({stored:true,email:a[2]});}
else if(a.includes('list'))send({accounts:[{email:fs.readFileSync(path.join(process.env.HOME,'identity'),'utf8'),subject:'google-subject',valid:true,scopes:['recorded']}]});
else if(a.includes('login')){if(!a.includes('--refresh-token-env')||process.env.FALCON_LINK_LOGIN_REFRESH!=='private-refresh-fixture')process.exit(9);send({saved:true});}
else if(a.includes('check'))send({verified:true,profile:a[a.indexOf('--account')+1],identity:{id:'microsoft-subject',mail:'ms@example.com'}});
else process.exit(9);`,
				{ mode: 0o700 }
			);
		}
		globalThis.fetch = async (url, options = {}) => {
			const u = new URL(url);
			if (u.hostname === 'login.microsoftonline.com') {
				attempts++;
				const p = new URLSearchParams(options.body);
				assert.equal(p.get('grant_type'), 'authorization_code');
				assert.equal(p.get('code'), 'private-code-fixture');
				assert.equal(p.get('redirect_uri'), 'https://callback.example/oauth2/callback/microsoft');
				assert.ok(p.get('code_verifier'));
				return Response.json({ refresh_token: 'private-refresh-fixture' });
			}
			assert.equal(u.origin, 'https://callback.example');
			assert.equal(options.redirect, 'error');
			if (u.pathname === '/health') return Response.json({ version: '0.1.0', protocol: 1 });
			if (u.pathname === '/v1/sessions') {
				assert.equal(options.headers.Authorization, 'Bearer ' + token);
				const v = JSON.parse(options.body);
				const id = sha(v.state);
				sessions.set(id, { ...v });
				return Response.json({ id, protocol: 1, expires_in: 600 }, { status: 201 });
			}
			const session = sessions.get(u.pathname.split('/').pop());
			assert.ok(session);
			assert.equal(sha(options.headers.Authorization.slice(7)), session.poll_hash);
			if (options.method === 'DELETE') {
				session.cancelled = true;
				return Response.json({ cancelled: true });
			}
			if (!session.result) return Response.json({ pending: true }, { status: 202 });
			if (session.cancelled || session.consumed)
				return Response.json({ error: 'unavailable' }, { status: 404 });
			session.consumed = true;
			return Response.json(session.result);
		};
		const l = new LinkService(dir);
		const owner = { kind: 'human', id: 'fred', name: 'Fred' };
		async function deliver(login, error) {
			const session = sessions.get(sha(new URL(login.url).searchParams.get('state')));
			const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
				'encrypt'
			]);
			const iv = randomBytes(12);
			const pub = await webcrypto.subtle.importKey(
				'jwk',
				session.public_key,
				{ name: 'RSA-OAEP', hash: 'SHA-256' },
				false,
				['encrypt']
			);
			session.result = {
				key: b64(
					await webcrypto.subtle.encrypt(
						'RSA-OAEP',
						pub,
						await webcrypto.subtle.exportKey('raw', key)
					)
				),
				iv: b64(iv),
				ciphertext: b64(
					await webcrypto.subtle.encrypt(
						{ name: 'AES-GCM', iv },
						key,
						Buffer.from(
							JSON.stringify({
								state: session.state,
								provider: session.provider,
								...(error ? { error } : { code: 'private-code-fixture' })
							})
						)
					)
				)
			};
		}
		try {
			await run({ l, owner, deliver, sessions, attempts: () => attempts, dir });
		} finally {
			l.stop();
		}
	} finally {
		globalThis.fetch = oldFetch;
		if (oldKey === undefined) delete process.env.FALCON_LINK_KEYRING_PASSWORD;
		else process.env.FALCON_LINK_KEYRING_PASSWORD = oldKey;
		await rm(dir, { recursive: true, force: true });
	}
}
test('hosted Google and Microsoft complete automatically in exact local CLI stores without disclosing handoff secrets', () =>
	scenario(async ({ l, owner, deliver, attempts }) => {
		for (const provider of ['google', 'microsoft']) {
			const login = await l.start(
				{
					provider,
					owner,
					purpose: { kind: 'work' },
					permissions: provider === 'google' ? ['gmail-read'] : ['mail-read'],
					email: 'google@example.com'
				},
				'fred'
			);
			assert.equal(login.state, 'awaiting_consent');
			assert.equal(login.hosted, true);
			assert.doesNotMatch(
				JSON.stringify(login),
				/privateKey|pollToken|poll_hash|verifier|fixture-secret/
			);
			assert.equal(
				new URL(login.url).searchParams.get('redirect_uri'),
				`https://callback.example/oauth2/callback/${provider}`
			);
			if (provider === 'microsoft')
				assert.equal(new URL(login.url).searchParams.get('code_challenge_method'), 'S256');
			await assert.rejects(() => l.poll(login.id, 'other'), /not found/);
			assert.equal((await l.poll(login.id, 'fred')).state, 'awaiting_consent');
			await deliver(login);
			const done = await l.poll(login.id, 'fred');
			assert.equal(done.state, 'connected');
			assert.equal(l.registry.get(login.account_id).state, 'connected');
			assert.equal(l.registry.get(login.account_id).provider_id, provider + '-subject');
			assert.equal((await l.poll(login.id, 'fred')).state, 'connected');
		}
		assert.equal(attempts(), 1);
	}));
test('cancelled and denied hosted sign-ins cannot become connected', () =>
	scenario(async ({ l, owner, deliver, attempts }) => {
		const input = {
			provider: 'microsoft',
			owner,
			purpose: { kind: 'work' },
			permissions: ['mail-read']
		};
		const cancelled = await l.start(input, 'fred');
		await deliver(cancelled);
		l.cancel(cancelled.id, 'fred');
		assert.equal((await l.poll(cancelled.id, 'fred')).state, 'cancelled');
		const denied = await l.start(input, 'fred');
		await deliver(denied, 'consent_not_completed');
		assert.equal((await l.poll(denied.id, 'fred')).state, 'failed');
		assert.equal(attempts(), 0);
	}));
test('a callback version mismatch fails before enrolling a session', () =>
	scenario(async ({ dir }) => {
		await assert.rejects(
			() =>
				CallbackHandoff.create(
					{
						url: 'https://callback.example',
						office: 'bravo',
						token_file: path.join(dir, 'callback-token'),
						version: '9.0.0'
					},
					'google',
					'state-01234567890123456789'
				),
			/version/
		);
	}));
