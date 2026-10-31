import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accountHome, isolatedEnvironment, json, run, runRaw } from '../../cli.js';
import { existingId, inventory, strings, validEmail } from '../../discover.js';
import type { Account } from '../../model.js';
import { PublicError, type Host, type ProviderModule } from '../types.js';
import ui from './ui.js';

const DOWNLOADS = 'https://api.hubapi.com/hub/cli/backend/hub-cli/latest';
// HubSpot's own page shows the code after approval; Link needs no client or callback.
const HOSTS = /^app(?:-[a-z0-9]+)?\.hubspot\.com$/;
const PORTAL = /^\d{1,20}$/;
// Variables that select an account or override sign-in; never inherited from the host.
const SELECTION = ['HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_PORTAL_ID'];
const serviceKey = (a: Account) => a.auth === 'service_key';
// The CLI wraps machine output as {ok, data} or {ok:false, error}.
function data(out: any) {
	if (out && typeof out === 'object' && 'ok' in out) {
		if (out.ok !== true) throw new Error('HubSpot returned an error.');
		return out.data;
	}
	return out;
}
// The service key lives only in this account's own HubSpot settings directory (0600).
// HubSpot CLI 0.16.0 reads keys only from HUBSPOT_ACCESS_TOKEN, so Link passes it from here.
const keyFile = (dir: string, id: string) =>
	path.join(accountHome(dir, id), '.config', 'hubspot', '.env');
function readKey(dir: string, id: string) {
	try {
		const m = /^HUBSPOT_ACCESS_TOKEN=(.+)$/m.exec(readFileSync(keyFile(dir, id), 'utf8'));
		return m?.[1].trim();
	} catch {
		return undefined;
	}
}
const KEY = /^[A-Za-z0-9_.:-]{16,512}$/;
// Single-quoted for a POSIX shell command line.
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// Known HubSpot failures in plain words. Raw CLI output is never shown or saved.
function signInError(text: string) {
	if (
		/governance|admin(?:istrator)? approval|requires? approval|not (?:been )?approved|pending approval/i.test(
			text
		)
	)
		return new PublicError(
			'hubspot_admin_approval',
			"Your HubSpot account's administrator needs to approve the HubSpot CLI app before you can connect. Ask them to allow it in HubSpot's app settings (App Governance), then try again."
		);
	if (/portal/i.test(text) && /different|mismatch|does not match|landed|wrong/i.test(text))
		return new PublicError(
			'hubspot_wrong_portal',
			'You approved access for a different HubSpot account. Start again and choose the account you meant to connect.'
		);
	if (/BAD_AUTH_CODE|unknown auth code|expired|invalid_grant/i.test(text))
		return new PublicError(
			'hubspot_code_expired',
			'That code has expired or was already used. Start again and paste the new code straight away.'
		);
	return new PublicError('hubspot_signin_failed', 'HubSpot sign-in did not complete. Start again.');
}
async function portals(tool: string, env: NodeJS.ProcessEnv) {
	return inventory(data(await json(tool, ['auth', 'list', '--format', 'json'], env, 10000)));
}
// Confirms who a stored sign-in or key belongs to and what HubSpot granted.
async function whoami(tool: string, env: NodeJS.ProcessEnv, a: Account, completingLogin: boolean) {
	const out = await runRaw(tool, ['whoami', '--format', 'json'], env);
	let me: any;
	try {
		// 0.16.0 returns whoami as a one-element list, unlike its help text.
		me = data(JSON.parse(out.stdout));
		if (Array.isArray(me)) me = me.length === 1 ? me[0] : null;
	} catch {
		me = null;
	}
	if (!out.ok || !me) {
		if (serviceKey(a) && /\b401\b|AUTH_TOKEN|rejected/i.test(out.stdout + out.stderr))
			throw new PublicError(
				'hubspot_key_rejected',
				"HubSpot didn't accept the service key. Check that you copied the whole key and that it is still active in HubSpot."
			);
		throw new Error('Identity not verified.');
	}
	const portal = String(me.portalId);
	if (!PORTAL.test(portal) || me.authType !== (serviceKey(a) ? 'service_key' : 'oauth'))
		throw new Error('Identity not verified.');
	if (a.provider_id && a.provider_id !== portal)
		throw new PublicError(
			'hubspot_wrong_portal',
			`This connection now belongs to a different HubSpot account. Reconnect to HubSpot account ${a.provider_id}.`
		);
	a.provider_id = portal;
	if (serviceKey(a)) {
		a.email = null;
		a.granted_scopes = null;
		a.recorded_scopes = null;
		return;
	}
	if (!validEmail(me.user)) throw new Error('Identity not verified.');
	if (a.email && a.email.toLowerCase() !== me.user.toLowerCase())
		throw new PublicError(
			'hubspot_wrong_user',
			`HubSpot confirmed a different person than ${a.email}. Reconnect as ${a.email}, or add the other person as a separate account.`
		);
	a.email = me.user;
	// whoami reports the scopes HubSpot granted to this sign-in.
	a.granted_scopes = strings(me.scopes, 128).slice(0, 300);
	a.grant = { status: 'known', selected_not_granted: null };
	a.recorded_scopes = null;
	if (completingLogin && !a.granted_scopes.some((s) => !ui.baseline.includes(s)))
		throw new PublicError(
			'hubspot_no_permissions',
			"HubSpot didn't give Falcon Link any permissions. Start again and allow access on HubSpot's approval page."
		);
}

const hubspot: ProviderModule = {
	ui,
	tool: {
		binary: 'hubspot',
		// HubSpot Agent CLI 0.16.0: `auth login url`/`exchange`, `whoami` and `auth list` JSON.
		minimum: '0.16.0',
		version_prefix: 'hubspot ',
		source: {
			kind: 'vendor',
			binary: (arch) => `${DOWNLOADS}/hubspot-linux-${arch}.bin`,
			checksum: (arch) => `${DOWNLOADS}/hubspot-linux-${arch}.sha256`,
			upgrade: ['upgrade']
		}
	},
	// HubSpot's official Agent CLI skills (Apache-2.0), installed for every agent.
	skills: { repo: 'HubSpot/agent-cli-skills', branch: 'main', prefix: 'hubspot-' },
	methods: ['paste_code', 'api_key'],
	// Sign-in uses HubSpot's own app and code page; nothing needs provisioning.
	readiness: () => ({ state: 'ready', message: '' }),
	async discover(tool) {
		const env = { ...process.env };
		for (const key of SELECTION) delete env[key];
		const accounts: Account[] = [];
		for (const entry of await portals(tool, env)) {
			const portal = String(entry.portalId);
			if (!PORTAL.test(portal)) continue;
			accounts.push({
				id: existingId(['hubspot', process.env.HOME, process.env.XDG_CONFIG_HOME, portal]),
				provider: 'hubspot',
				email: validEmail(entry.user) ? entry.user : null,
				owner: null,
				purpose: null,
				provider_id: portal,
				requested: [],
				recorded_scopes: strings(entry.scopes, 128).slice(0, 300),
				granted_scopes: null,
				auth: 'oauth',
				state: 'discovered',
				checked_at: null,
				created_at: new Date().toISOString(),
				external: { selection: portal }
			});
		}
		return accounts;
	},
	environment(dir, a) {
		const env = a.external ? { ...process.env } : isolatedEnvironment(dir, a.id);
		for (const key of SELECTION) delete env[key];
		if (serviceKey(a)) {
			const key = readKey(dir, a.id);
			if (key) env.HUBSPOT_ACCESS_TOKEN = key;
		} else if (a.provider_id) env.HUBSPOT_PORTAL_ID = a.provider_id;
		return env;
	},
	validate(_input, prior) {
		if (prior && serviceKey(prior))
			throw new Error('This account uses a service key. Paste a new key to reconnect it.');
	},
	async start(host, l, a, stage) {
		Object.assign(stage, {
			code: 'hubspot_authorization_start',
			message: 'HubSpot sign-in could not start. Try again.'
		});
		a.auth = 'oauth';
		host.registry.save(a);
		// Saves the PKCE verifier in this account's own HubSpot settings; prints the address.
		const out = await run(host.tool(a), ['auth', 'login', 'url'], host.env(a));
		if (l.state !== 'starting') return;
		const url = new URL(out.trim().split('\n')[0].trim());
		const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
		if (
			url.protocol !== 'https:' ||
			!HOSTS.test(url.hostname) ||
			!url.pathname.startsWith('/oauth/') ||
			url.searchParams.get('code_challenge_method') !== 'S256' ||
			!url.searchParams.get('code_challenge') ||
			redirect.protocol !== 'https:' ||
			!HOSTS.test(redirect.hostname) ||
			redirect.pathname !== '/cli-auth/code'
		)
			throw new Error('Provider authorization URL could not be verified.');
		l.url = url.href;
		l.paste = { label: 'Code shown by HubSpot', kind: 'text' };
		l.state = 'awaiting_consent';
		l.message =
			'Sign in to HubSpot and approve access. HubSpot then shows a code: copy it and paste it here.';
	},
	async finish(host, l, value) {
		let code = value.trim();
		if (/^https:\/\//.test(code)) code = new URL(code).searchParams.get('code') ?? '';
		if (!/^[A-Za-z0-9._~-]{4,1024}$/.test(code))
			throw new Error('Paste the code HubSpot showed after you approved access.');
		l.state = 'verifying';
		const a = host.registry.get(l.account_id);
		const tool = host.tool(a);
		const env = host.env(a);
		const exchange = await runRaw(tool, ['auth', 'login', 'exchange', '--code', code], env, 60000);
		if (!exchange.ok) {
			const e = signInError(exchange.stdout + exchange.stderr);
			return host.fail(l, e.message, e.code);
		}
		try {
			if (!a.provider_id) {
				// A new account's own store holds exactly the portal just approved.
				const found = await portals(tool, env);
				const portal = String(found[0]?.portalId);
				if (found.length !== 1 || !PORTAL.test(portal)) throw new Error('Portal not confirmed.');
				a.provider_id = portal;
				host.registry.save(a);
			}
			await host.check(a.id, true);
			l.state = 'connected';
			l.url = null;
			l.message = 'Account connected.';
		} catch (e) {
			if (e instanceof PublicError) host.fail(l, e.message, e.code);
			else
				host.fail(
					l,
					'HubSpot sign-in finished, but the account could not be confirmed. Start again.',
					'hubspot_identity_check'
				);
		}
	},
	async connectKey(host, a, key, prior) {
		key = key.trim();
		if (!KEY.test(key))
			throw new PublicError(
				'hubspot_key_invalid',
				"That doesn't look like a HubSpot service key. Copy the whole key and try again."
			);
		const file = keyFile(host.dir, a.id);
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const pending = `${file}.${randomUUID()}`;
		try {
			const env = isolatedEnvironment(host.dir, a.id);
			for (const name of SELECTION) delete env[name];
			env.HUBSPOT_ACCESS_TOKEN = key;
			a.provider_id = null;
			await whoami(host.tool(a), env, a, true);
			if (prior?.provider_id && prior.provider_id !== a.provider_id)
				throw new PublicError(
					'hubspot_wrong_portal',
					`That key is for a different HubSpot account. Use a key for HubSpot account ${prior.provider_id}.`
				);
			writeFileSync(pending, `HUBSPOT_ACCESS_TOKEN=${key}\n`, { mode: 0o600 });
			renameSync(pending, file);
		} finally {
			rmSync(pending, { force: true });
		}
	},
	verify: (host, a, completingLogin) => whoami(host.tool(a), host.env(a), a, completingLogin),
	async remove(host, a) {
		// A service key exists only in this account's directory, which Link deletes.
		if (serviceKey(a)) return;
		const tool = host.tool(a);
		const env = host.env(a);
		const signedIn = (list: any[]) =>
			a.provider_id ? list.some((p) => String(p.portalId) === a.provider_id) : list.length > 0;
		if (signedIn(await portals(tool, env)))
			await run(tool, a.provider_id ? ['auth', 'logout'] : ['auth', 'logout', '--all'], env);
		if (signedIn(await portals(tool, env)))
			throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		const executable = host.tool(a);
		if (serviceKey(a)) {
			const file = keyFile(host.dir, a.id);
			return {
				account: a,
				executable,
				arguments: [],
				environment: {},
				environment_file: file,
				unset_environment: ['HUBSPOT_PORTAL_ID'],
				inherited_environment: [],
				// Reads the key at run time so it never appears in the conversation.
				command_prefix: `env -u HUBSPOT_PORTAL_ID HUBSPOT_ACCESS_TOKEN="$(sed -n 's/^HUBSPOT_ACCESS_TOKEN=//p' ${quote(file)})" ${quote(executable)}`,
				requested_scopes: null,
				granted_scopes: null
			};
		}
		// exec refuses XDG overrides in its env parameter, so the settings also come as a
		// command prefix that selects this account's store and portal.
		const environment: Record<string, string> = a.external
			? { HUBSPOT_PORTAL_ID: a.provider_id! }
			: {
					XDG_CONFIG_HOME: host.env(a).XDG_CONFIG_HOME!,
					HUBSPOT_PORTAL_ID: a.provider_id!
				};
		return {
			account: a,
			executable,
			arguments: [],
			environment,
			unset_environment: ['HUBSPOT_ACCESS_TOKEN'],
			inherited_environment: [],
			command_prefix: `env -u HUBSPOT_ACCESS_TOKEN ${Object.entries(environment)
				.map(([k, v]) => `${k}=${quote(v)}`)
				.join(' ')} ${quote(executable)}`,
			requested_scopes: null,
			granted_scopes: a.granted_scopes
		};
	},
	identified: (a) => !!a.provider_id,
	brief: {
		heading: 'hubspot',
		note: 'For hubspot accounts falcon_link_accounts also returns a command_prefix that selects the account.',
		identity: (a) =>
			serviceKey(a)
				? `HubSpot account ${a.provider_id} (service key)`
				: (a.email ?? `HubSpot account ${a.provider_id}`),
		scopes(a) {
			if (serviceKey(a)) return 'service key: access set in HubSpot';
			const values = a.granted_scopes ?? a.recorded_scopes;
			return values?.length ? [...new Set(values)].join('; ') : 'unknown';
		}
	}
};
export default hubspot;
