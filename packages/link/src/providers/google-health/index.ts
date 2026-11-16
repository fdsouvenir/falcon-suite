import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { CallbackHandoff, callbackConfig, callbackURI } from '../../callback.js';
import { accountHome, isolatedEnvironment, json, provision } from '../../cli.js';
import { validEmail } from '../../discover.js';
import type { Account } from '../../model.js';
import { PublicError, type Host, type Login, type ProviderModule } from '../types.js';
import ui, { SCOPES } from './ui.js';

// Link signs in with the Office's Google web client (the one the Google integration uses) and
// the sign-in return service, then writes the sign-in where ghcli reads it: `--store <dir>` holds
// `token.json` (a golang.org/x/oauth2 Token) and ghcli's archive `ghcli.db`
// (internal/paths/paths.go). ghcli only accepts an `installed` client (internal/health/auth.go
// ParseCredentials), so the account also gets the same client ID and secret in that shape;
// ghcli refreshes the token with them and saves it back.
const ID = 'google-health';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const SETUP = "Google Health sign-in isn't set up on this Office. Contact your administrator.";

type Client = { id: string; secret: string };
type Token = {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope: string[] | null;
};

// The Office's Google web client, provisioned for the sign-in return service.
function webClient(dir: string): Client | null {
	const p = provision(dir);
	if (!p.callback) return null;
	try {
		const web = JSON.parse(readFileSync(p.google_credentials_file ?? '', 'utf8'))?.web;
		const { client_id: id, client_secret: secret } = web ?? {};
		if (typeof id === 'string' && id && typeof secret === 'string' && secret) return { id, secret };
	} catch {}
	return null;
}
const configured = (dir: string) => {
	const c = webClient(dir);
	if (!c) throw new PublicError('google_health_setup', SETUP);
	return c;
};
// ghcli's state directory for this account (`--store`) and its Google client file.
const store = (dir: string, a: Account) => path.join(accountHome(dir, a.id), 'ghcli');
const clientFile = (dir: string, a: Account) =>
	path.join(accountHome(dir, a.id), 'google-oauth-client.json');
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function writePrivate(file: string, value: unknown) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const pending = `${file}.${randomUUID()}`;
	try {
		writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
		renameSync(pending, file);
	} finally {
		rmSync(pending, { force: true });
	}
}
// The golang.org/x/oauth2 Token JSON that ghcli loads and saves.
function writeToken(dir: string, a: Account, t: Token, refresh: string) {
	writePrivate(path.join(store(dir, a), 'token.json'), {
		access_token: t.access_token,
		token_type: 'Bearer',
		refresh_token: refresh,
		expiry: new Date(Date.now() + t.expires_in * 1000).toISOString()
	});
}
function readJSON(file: string) {
	try {
		if (statSync(file).size <= 65536) return JSON.parse(readFileSync(file, 'utf8'));
	} catch {}
	return null;
}

const failed = () =>
	new PublicError('google_health_exchange_failed', "Google couldn't finish sign-in. Start again.");
async function token(c: Client, grant: Record<string, string>): Promise<Token> {
	let response: Response;
	let t: any;
	try {
		response = await fetch(TOKEN, {
			method: 'POST',
			body: new URLSearchParams({ ...grant, client_id: c.id, client_secret: c.secret }),
			redirect: 'error',
			signal: AbortSignal.timeout(20000)
		});
		t = await response.json();
	} catch {
		throw failed();
	}
	if (t?.error === 'invalid_grant')
		throw new PublicError(
			'google_health_grant_invalid',
			grant.grant_type === 'refresh_token'
				? 'Google no longer accepts this sign-in. It may have been revoked or expired. Reconnect.'
				: 'That sign-in has expired or was already used. Start again.'
		);
	if (!response.ok || typeof t?.access_token !== 'string' || typeof t.expires_in !== 'number')
		throw failed();
	return {
		access_token: t.access_token,
		...(typeof t.refresh_token === 'string' ? { refresh_token: t.refresh_token } : {}),
		expires_in: t.expires_in,
		scope: typeof t.scope === 'string' ? t.scope.split(' ').filter(Boolean) : null
	};
}
// The Google account the access token belongs to.
async function identity(t: Token) {
	try {
		const response = await fetch(USERINFO, {
			headers: { Authorization: `Bearer ${t.access_token}` },
			redirect: 'error',
			signal: AbortSignal.timeout(15000)
		});
		const me = (await response.json()) as any;
		const sub = typeof me?.sub === 'string' && /^[\x21-\x7e]{1,255}$/.test(me.sub) ? me.sub : null;
		if (response.ok && sub && validEmail(me.email)) return { sub: sub as string, email: me.email };
	} catch {}
	throw new PublicError(
		'google_health_identity_failed',
		"Google signed in, but Link couldn't confirm the account. Start again."
	);
}
function granted(a: Account, t: Token) {
	if (!t.scope) return;
	a.granted_scopes = t.scope;
	a.grant = { status: 'known', selected_not_granted: null };
	a.recorded_scopes = null;
}

async function begin(host: Host, l: Login) {
	const c = configured(host.dir);
	const callback = callbackConfig(host.dir);
	if (!callback) throw new PublicError('google_health_setup', SETUP);
	const state = randomBytes(32).toString('base64url');
	l.verifier = randomBytes(48).toString('base64url');
	const url = new URL(AUTHORIZE);
	url.search = new URLSearchParams({
		client_id: c.id,
		redirect_uri: callbackURI(callback, ID),
		response_type: 'code',
		scope: SCOPES.join(' '),
		access_type: 'offline',
		prompt: 'consent',
		state,
		code_challenge: createHash('sha256').update(l.verifier).digest('base64url'),
		code_challenge_method: 'S256'
	}).toString();
	l.callback = await CallbackHandoff.create(callback, ID, state);
	if (l.state !== 'starting') {
		await l.callback.cancel();
		return;
	}
	l.hosted = true;
	l.expires_at = new Date(Date.now() + 10 * 60000).toISOString();
	l.url = url.href;
	l.state = 'awaiting_consent';
	l.message =
		'Sign in with Google and allow access, then return here. Your account will connect automatically.';
}

const googleHealth: ProviderModule = {
	ui,
	tool: {
		binary: 'ghcli',
		// TODO: the first ghcli release with release archives (fdsouvenir/ghcli#1). Releases up to
		// v1.0.4 have no assets and v1.0.5 has no release.
		minimum: '1.0.6',
		source: {
			kind: 'github',
			repo: 'fdsouvenir/ghcli',
			archive: 'ghcli',
			checksums: 'checksums.txt'
		},
		// ghcli has no --version flag; `ghcli version` prints the version alone (v1.0.6).
		version_args: ['version']
	},
	// ghcli's own agent skill (MIT), kept in the CLI's repository.
	skills: { repo: 'fdsouvenir/ghcli', branch: 'main', prefix: 'ghcli-', path: 'skills' },
	methods: ['hosted_callback'],
	readiness(dir) {
		const ready = !!webClient(dir);
		return { state: ready ? 'ready' : 'setup_required', message: ready ? '' : SETUP };
	},
	discover: async () => [],
	environment(dir, a) {
		const env = isolatedEnvironment(dir, a.id);
		env.GHCLI_GOOGLE_CREDENTIALS = clientFile(dir, a);
		return env;
	},
	async start(host, l, _a, stage) {
		Object.assign(stage, {
			code: 'google_health_authorization_start',
			message: "Google Health sign-in couldn't start. Try again."
		});
		await begin(host, l);
	},
	async complete(host, l, code) {
		const c = configured(host.dir);
		l.state = 'verifying';
		l.url = null;
		const t = await token(c, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: callbackURI(l.callback!.config, ID),
			code_verifier: l.verifier!
		});
		if (!t.refresh_token) throw failed();
		const me = await identity(t);
		const prior = l.prior?.provider_id;
		if (prior && prior !== me.sub)
			throw new PublicError(
				'google_health_wrong_account',
				`Google signed in a different account. Sign in as ${l.prior?.email ?? 'the account connected here before'} to reconnect it, or add the other account separately.`
			);
		const a = host.registry.get(l.account_id);
		a.provider_id = me.sub;
		a.email = me.email;
		granted(a, t);
		host.registry.save(a);
		writePrivate(clientFile(host.dir, a), {
			installed: {
				client_id: c.id,
				client_secret: c.secret,
				auth_uri: AUTHORIZE,
				token_uri: TOKEN
			}
		});
		writeToken(host.dir, a, t, t.refresh_token);
		await host.check(a.id, true);
		l.state = 'connected';
		l.message = 'Account connected.';
	},
	async verify(host, a) {
		const dir = store(host.dir, a);
		// ghcli reads the saved sign-in (locally, without calling Google).
		const status = await json(
			host.tool(a),
			['--json', '--store', dir, 'auth', 'status'],
			host.env(a)
		);
		if (status?.present !== true || status.has_refresh_token !== true)
			throw new Error('Identity not verified.');
		// A live refresh with the client and refresh token ghcli uses, then the account it belongs to.
		const saved = readJSON(path.join(dir, 'token.json'));
		const installed = readJSON(clientFile(host.dir, a))?.installed;
		if (
			typeof saved?.refresh_token !== 'string' ||
			typeof installed?.client_id !== 'string' ||
			typeof installed.client_secret !== 'string'
		)
			throw new Error('Identity not verified.');
		const t = await token(
			{ id: installed.client_id, secret: installed.client_secret },
			{ grant_type: 'refresh_token', refresh_token: saved.refresh_token }
		);
		const me = await identity(t);
		if (a.provider_id && a.provider_id !== me.sub)
			throw new PublicError(
				'google_health_wrong_account',
				`This connection now belongs to a different Google account. Reconnect as ${a.email ?? 'the account connected before'}.`
			);
		// Google may issue a new refresh token; ghcli needs the current one.
		if (t.refresh_token && t.refresh_token !== saved.refresh_token)
			writeToken(host.dir, a, t, t.refresh_token);
		a.provider_id = me.sub;
		a.email = me.email;
		granted(a, t);
	},
	async remove(host, a) {
		// This account's ghcli store (sign-in and archive) and its client file.
		const dir = store(host.dir, a);
		const file = clientFile(host.dir, a);
		rmSync(dir, { recursive: true, force: true });
		rmSync(file, { force: true });
		if (existsSync(dir) || existsSync(file))
			throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		const dir = store(host.dir, a);
		const file = clientFile(host.dir, a);
		const executable = host.tool(a);
		return {
			account: a,
			executable,
			arguments: ['--store', dir],
			environment: { GHCLI_GOOGLE_CREDENTIALS: file },
			inherited_environment: [],
			command_prefix: `env GHCLI_GOOGLE_CREDENTIALS=${quote(file)} ${quote(executable)} --store ${quote(dir)}`,
			requested_scopes: SCOPES,
			granted_scopes: a.granted_scopes
		};
	},
	identified: (a) => !!a.provider_id,
	brief: {
		heading: 'ghcli',
		note: "For ghcli accounts falcon_link_accounts also returns a command_prefix that selects the account's store and Google client. ghcli answers queries from its local archive in that store, which holds what `ghcli sync` has fetched from Google Health.",
		identity: (a) => a.email ?? 'Google Health account (not checked yet)',
		scopes(a) {
			if (!a.granted_scopes) return 'unknown';
			const values = a.granted_scopes
				.map((s) => ui.access.labels[ui.access.key!(s)])
				.filter(Boolean);
			return values.length ? values.join('; ') : 'none';
		}
	}
};
export default googleHealth;
