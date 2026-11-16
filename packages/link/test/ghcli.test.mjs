import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { LinkService } from '../dist/service.js';
import { accessSummary } from '../dist/access-summary.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const b64 = (v) => Buffer.from(v).toString('base64');
const AUTH = 'https://www.googleapis.com/auth/googlehealth.';
const HEALTH = [
	'activity_and_fitness',
	'health_metrics_and_measurements',
	'location',
	'nutrition',
	'profile',
	'settings',
	'sleep'
].map((s) => `${AUTH}${s}.readonly`);
// A stand-in for ghcli 1.0.6 that reads its store the way internal/paths and internal/health do:
// `--store <dir>` holds token.json (golang.org/x/oauth2 Token JSON), and the Google client comes
// from GHCLI_GOOGLE_CREDENTIALS, which must be an `installed` client (ParseCredentials).
const fixture = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(a[0]==='version'){console.log('v1.0.6');process.exit();}
const at=a.indexOf('--store');if(at<0)process.exit(3);
const store=a[at+1],rest=a.filter((x,i)=>i!==at&&i!==at+1&&x!=='--json').join(' '),file=path.join(store,'token.json');
if(rest==='auth status'){let t=null;try{t=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 const ok=!!t&&(t.access_token||t.refresh_token)&&t.token_type==='Bearer'&&!isNaN(Date.parse(t.expiry));
 send(ok?{token_store:'file:'+file,present:true,has_refresh_token:!!t.refresh_token,expiry:t.expiry,expired:false}:{token_store:'file:'+file,present:false,error:'token not found'});process.exit();}
if(rest==='auth setup'){const c=JSON.parse(fs.readFileSync(process.env.GHCLI_GOOGLE_CREDENTIALS,'utf8')).installed;
 if(!c?.client_id||!c?.client_secret){console.error('missing installed.client_id/client_secret');process.exit(1);}
 send({credentials_source_type:'file',credentials_source:'GHCLI_GOOGLE_CREDENTIALS',token_store:'file:'+file});process.exit();}
process.exit(9);`;

// Google's answers by authorization code: the account and the scopes the person allowed.
const people = {
	'fred-code': { sub: 'google-fred', email: 'fred@example.com', withheld: ['location'] },
	'kim-code': { sub: 'google-kim', email: 'kim@example.com', withheld: [] }
};
const scopeString = (withheld) =>
	[
		'openid',
		'https://www.googleapis.com/auth/userinfo.email',
		...HEALTH.filter((s) => !withheld.some((w) => s.includes(`.${w}.`)))
	].join(' ');

async function scenario(run, { callback = true } = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), 'link-ghcli-'));
	const oldFetch = globalThis.fetch,
		oldPath = process.env.PATH;
	const sessions = new Map(),
		requests = [],
		access = new Map();
	// What Google currently reports for the refresh token (changed by tests).
	const refreshes = new Map();
	try {
		const bin = path.join(dir, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'ghcli'), fixture, { mode: 0o700 });
		process.env.PATH = bin + path.delimiter + oldPath;
		const token = randomBytes(32).toString('base64url'),
			tokenFile = path.join(dir, 'callback-token');
		await writeFile(tokenFile, token, { mode: 0o600 });
		const credentials = path.join(dir, 'google.json');
		await writeFile(
			credentials,
			JSON.stringify({ web: { client_id: 'web-client', client_secret: 'web-secret' } }),
			{ mode: 0o600 }
		);
		const link = path.join(dir, 'link');
		await mkdir(link);
		await writeFile(
			path.join(link, 'provision.json'),
			JSON.stringify({
				google_credentials_file: credentials,
				...(callback
					? {
							callback: {
								url: 'https://callback.example',
								office: 'bravo',
								token_file: tokenFile,
								version: '0.1.3'
							}
						}
					: {})
			})
		);
		let issued = 0;
		globalThis.fetch = async (url, options = {}) => {
			const u = new URL(url);
			if (u.href === 'https://oauth2.googleapis.com/token') {
				const p = Object.fromEntries(new URLSearchParams(options.body));
				requests.push(p);
				const at = `access-${++issued}`;
				if (p.grant_type === 'authorization_code') {
					const who = people[p.code];
					if (!who) return Response.json({ error: 'invalid_grant' }, { status: 400 });
					access.set(at, who);
					refreshes.set(`private-refresh-${who.sub}`, { who, scope: scopeString(who.withheld) });
					return Response.json({
						access_token: at,
						expires_in: 3599,
						refresh_token: `private-refresh-${who.sub}`,
						scope: scopeString(who.withheld),
						token_type: 'Bearer',
						id_token: 'unused'
					});
				}
				const r = refreshes.get(p.refresh_token);
				if (p.grant_type !== 'refresh_token' || !r)
					return Response.json({ error: 'invalid_grant' }, { status: 400 });
				access.set(at, r.who);
				return Response.json({ access_token: at, expires_in: 3599, scope: r.scope });
			}
			if (u.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
				const who = access.get(options.headers.Authorization.slice(7));
				return who
					? Response.json({ sub: who.sub, email: who.email, email_verified: true })
					: Response.json({ error: 'invalid_token' }, { status: 401 });
			}
			assert.equal(u.origin, 'https://callback.example');
			if (u.pathname === '/health') return Response.json({ version: '0.1.3', protocol: 1 });
			if (u.pathname === '/v1/sessions') {
				const v = JSON.parse(options.body);
				sessions.set(sha(v.state), { ...v });
				return Response.json({ id: sha(v.state), protocol: 1, expires_in: 600 }, { status: 201 });
			}
			const session = sessions.get(u.pathname.split('/').pop());
			if (options.method === 'DELETE') {
				session.cancelled = true;
				return Response.json({ cancelled: true });
			}
			if (!session.result) return Response.json({ pending: true }, { status: 202 });
			session.consumed = true;
			return Response.json(session.result);
		};
		const l = new LinkService(link);
		// The Worker's encrypted handoff of an authorization code (or a refusal) for this sign-in.
		async function deliver(login, code) {
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
			const plain = { state: session.state, provider: session.provider, code };
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
						Buffer.from(JSON.stringify(plain))
					)
				)
			};
			return l.poll(login.id, 'fred');
		}
		const input = (extra = {}) => ({
			provider: 'google-health',
			owner: { kind: 'human', id: 'fred', name: 'Fred' },
			purpose: { kind: 'personal' },
			permissions: [],
			...extra
		});
		const home = (id) => path.join(link, 'accounts', id);
		try {
			await run({ l, deliver, input, home, requests, refreshes, link });
		} finally {
			l.stop();
		}
	} finally {
		globalThis.fetch = oldFetch;
		process.env.PATH = oldPath;
		await rm(dir, { recursive: true, force: true });
	}
}

test('Google Health signs in through the return service with the Google web client and writes the store and installed client ghcli reads', () =>
	scenario(async ({ l, deliver, input, home, requests, link }) => {
		const login = await l.start(input(), 'fred');
		assert.equal(login.state, 'awaiting_consent', login.message);
		assert.equal(login.hosted, true);
		const url = new URL(login.url);
		assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
		const q = Object.fromEntries(url.searchParams);
		assert.equal(q.client_id, 'web-client');
		assert.equal(q.redirect_uri, 'https://callback.example/oauth2/callback/google-health');
		assert.deepEqual(q.scope.split(' '), ['openid', 'email', ...HEALTH]);
		assert.equal(q.access_type, 'offline');
		assert.equal(q.prompt, 'consent');
		assert.equal(q.code_challenge_method, 'S256');
		const done = await deliver(login, 'fred-code');
		assert.equal(done.state, 'connected', done.message);
		const exchange = requests.find((p) => p.grant_type === 'authorization_code');
		assert.equal(exchange.client_id, 'web-client');
		assert.equal(exchange.client_secret, 'web-secret');
		assert.equal(exchange.redirect_uri, q.redirect_uri);
		assert.equal(
			createHash('sha256').update(exchange.code_verifier).digest('base64url'),
			q.code_challenge
		);

		const a = l.registry.get(login.account_id);
		assert.equal(a.email, 'fred@example.com');
		assert.equal(a.provider_id, 'google-fred');
		// Google let the person withhold location; access shows what was granted.
		assert.deepEqual(accessSummary(a).items, [
			'View activity and fitness data',
			'View health metrics and measurements',
			'View nutrition data',
			'View Google Health profile',
			'View Google Health settings',
			'View sleep data'
		]);
		const store = path.join(home(a.id), 'ghcli');
		const saved = JSON.parse(await readFile(path.join(store, 'token.json'), 'utf8'));
		assert.equal(saved.refresh_token, 'private-refresh-google-fred');
		assert.equal(saved.token_type, 'Bearer');
		assert.ok(Date.parse(saved.expiry) > Date.now());
		assert.equal(statSync(path.join(store, 'token.json')).mode & 0o777, 0o600);
		assert.equal(statSync(store).mode & 0o777, 0o700);
		const client = path.join(home(a.id), 'google-oauth-client.json');
		assert.deepEqual(JSON.parse(await readFile(client, 'utf8')), {
			installed: {
				client_id: 'web-client',
				client_secret: 'web-secret',
				auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
				token_uri: 'https://oauth2.googleapis.com/token'
			}
		});
		assert.equal(statSync(client).mode & 0o777, 0o600);

		const inv = await l.invocation(a.id);
		assert.deepEqual(inv.arguments, ['--store', store]);
		assert.deepEqual(inv.environment, { GHCLI_GOOGLE_CREDENTIALS: client });
		assert.deepEqual(inv.granted_scopes, a.granted_scopes);
		const env = { ...process.env, GHCLI_GOOGLE_CREDENTIALS: '/nonexistent' };
		const sh = (args) =>
			JSON.parse(
				execFileSync('sh', ['-c', `${inv.command_prefix} ${args}`], { env, encoding: 'utf8' })
			);
		assert.equal(sh('--json auth status').present, true, 'the prefix selects this account’s store');
		assert.equal(sh('--json auth setup').credentials_source, 'GHCLI_GOOGLE_CREDENTIALS');
		// Secrets stay in the account's files.
		assert.doesNotMatch(
			JSON.stringify([
				login,
				done,
				inv,
				l.accounts(),
				await readFile(path.join(link, 'accounts.json'), 'utf8')
			]),
			/web-secret|private-refresh|access-\d/
		);
	}));

test('Google Health checks refresh live, follow what Google reports, refuse another account on reconnect, and remove only this account', () =>
	scenario(async ({ l, deliver, input, home, refreshes }) => {
		const first = await deliver(await l.start(input(), 'fred'), 'fred-code');
		const id = first.account_id ?? l.accounts().find((a) => a.provider === 'google-health').id;
		const before = await readFile(path.join(home(id), 'ghcli', 'token.json'), 'utf8');
		// The person later turns off sleep at Google.
		refreshes.get('private-refresh-google-fred').scope = refreshes
			.get('private-refresh-google-fred')
			.scope.replace(` ${AUTH}sleep.readonly`, '');
		const checked = await l.check(id);
		assert.equal(checked.state, 'connected');
		assert.ok(!accessSummary(checked).items.includes('View sleep data'));

		const other = await l.start(input({ account_id: id }), 'fred');
		assert.equal((await deliver(other, 'kim-code')).state, 'failed');
		assert.equal(l.registry.get(id).connection_error.code, 'google_health_wrong_account');
		assert.equal(
			await readFile(path.join(home(id), 'ghcli', 'token.json'), 'utf8'),
			before,
			'the working sign-in is kept'
		);

		const second = await deliver(await l.start(input(), 'fred'), 'kim-code');
		assert.equal(second.state, 'connected');
		const kim = l.accounts().find((a) => a.email === 'kim@example.com');

		refreshes.delete('private-refresh-google-fred');
		await assert.rejects(() => l.check(id), /revoked or expired/);
		assert.equal(l.registry.get(id).state, 'check_failed');

		await l.remove(id);
		assert.equal(existsSync(path.join(home(id), 'ghcli')), false);
		assert.equal(existsSync(path.join(home(id), 'google-oauth-client.json')), false);
		assert.equal(existsSync(path.join(home(kim.id), 'ghcli', 'token.json')), true);
		assert.equal((await l.check(kim.id)).state, 'connected');
	}));

test('Google Health needs the return service', () =>
	scenario(
		async ({ l, input }) => {
			await assert.rejects(() => l.start(input(), 'fred'), /isn't set up on this Office/);
		},
		{ callback: false }
	));
