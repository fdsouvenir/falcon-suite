import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	CallbackHandoff,
	callbackConfig,
	callbackURI,
	microsoftAuthority
} from '../../callback.js';
import { microsoftCatalog, workOnly } from './catalog.js';
import { deviceLogin, isolatedEnvironment, json, keyringPassword, provision } from '../../cli.js';
import { existingId, inventory, strings, validEmail, validSelection } from '../../discover.js';
import { selectionScopes, type Account } from '../../model.js';
import { PublicError, type Host, type ProviderModule } from '../types.js';
import ui from './ui.js';

const KEYRING = 'M365CLI_KEYRING_PASSWORD';
const STORE = ['M365CLI_CONFIG_DIR', 'M365CLI_KEYRING_BACKEND'];
// Microsoft's "administrator approval required" errors.
const ADMIN_APPROVAL = /AADSTS(?:65001|90094)\b/;
const ADMIN_MESSAGE =
	'Your organization needs an administrator to approve Falcon Link before this account can connect.';
const selection = (a: Account) => a.external?.selection ?? a.id;
// The hosted redirect works only for the provisioned Link client. Profiles in m365cli's own
// store with another client use device-code sign-in.
function hostedCallback(host: Host, a: Account) {
	const callback = callbackConfig(host.dir);
	if (!callback || !a.external) return callback;
	return a.external.client_id === provision(host.dir).microsoft_client_id ? callback : undefined;
}

const microsoft: ProviderModule = {
	ui,
	tool: {
		binary: 'm365cli',
		// m365cli 2.1.0 added `auth workloads`, the grant report and `--audience auto`.
		minimum: '2.1.0',
		source: { kind: 'github', repo: 'fdsouvenir/m365cli', archive: 'm365cli' },
		version_prefix: 'm365cli version '
	},
	methods: ['hosted_callback', 'device_code'],
	readiness(dir) {
		const p = provision(dir);
		const ready =
			!!keyringPassword(KEYRING) &&
			/^[a-fA-F0-9-]{36}$/.test(p.microsoft_client_id ?? '') &&
			(!p.microsoft_tenant || /^[a-zA-Z0-9.-]{1,255}$/.test(p.microsoft_tenant));
		return {
			state: ready ? 'ready' : 'setup_required',
			message: ready
				? ''
				: "Microsoft sign-in isn't set up on this Office. Contact your administrator."
		};
	},
	async catalog(tool) {
		const out = await json(tool, ['auth', 'workloads', '--json', '--no-input'], process.env, 5000);
		return microsoftCatalog(out?.workloads);
	},
	async discover(tool) {
		const out = await json(tool, ['auth', 'status', '--json', '--no-input'], process.env, 5000);
		const accounts: Account[] = [];
		for (const entry of inventory(out.profiles)) {
			// App-only profiles are not logged-in human accounts.
			if (entry.auth_mode === 'app_only') continue;
			const email = entry.username;
			if (!validEmail(email) || !validSelection(entry.name)) continue;
			const clientId =
				typeof entry.client_id === 'string' && /^[a-fA-F0-9-]{36}$/.test(entry.client_id)
					? entry.client_id
					: undefined;
			accounts.push({
				id: existingId([
					'microsoft',
					process.env.HOME,
					process.env.XDG_CONFIG_HOME,
					undefined,
					undefined,
					...(process.env.M365CLI_CONFIG_DIR ? [process.env.M365CLI_CONFIG_DIR] : []),
					entry.name,
					undefined
				]),
				provider: 'microsoft',
				email,
				owner: null,
				purpose: null,
				provider_id: null,
				requested: strings(entry.delegated_scope_workloads),
				...(['consumer', 'enterprise'].includes(entry.audience)
					? { audience: entry.audience }
					: {}),
				recorded_scopes: null,
				granted_scopes: null,
				state: 'discovered',
				checked_at: null,
				created_at: new Date().toISOString(),
				external: { selection: entry.name, ...(clientId ? { client_id: clientId } : {}) }
			});
		}
		return accounts;
	},
	environment(dir, a) {
		if (a.external)
			return {
				...process.env,
				...(a.external.client_id ? { M365CLI_CLIENT_ID: a.external.client_id } : {})
			};
		const env = isolatedEnvironment(dir, a.id);
		Object.assign(env, {
			M365CLI_CONFIG_DIR: path.join(env.XDG_CONFIG_HOME!, 'm365cli'),
			M365CLI_KEYRING_BACKEND: 'file',
			M365CLI_KEYRING_PASSWORD: keyringPassword(KEYRING),
			M365CLI_CLIENT_ID: provision(dir).microsoft_client_id
		});
		// Do not inherit account selection from the host.
		for (const key of ['M365CLI_ACCOUNT', 'M365CLI_PROFILE', 'M365CLI_AUDIENCE']) delete env[key];
		return env;
	},
	// m365cli detects the account type itself, except where only work or school accounts
	// qualify or the operator provisioned a tenant.
	prepare(dir, input, catalog) {
		const tenant = provision(dir).microsoft_tenant;
		return tenant || workOnly(catalog!, input.permissions)
			? ['--audience', 'enterprise', ...(tenant ? ['--tenant', tenant] : [])]
			: ['--audience', 'auto'];
	},
	async start(host, l, a, stage) {
		const audience = l.prepared as string[];
		const callback = hostedCallback(host, a);
		const scopes = selectionScopes(ui, await host.catalog('microsoft'), a.requested);
		if (callback) {
			Object.assign(stage, {
				code: 'microsoft_authorization_start',
				message: 'Microsoft sign-in could not start. Check callback service and application setup.'
			});
			const p = provision(host.dir);
			const state = randomBytes(32).toString('base64url');
			l.verifier = randomBytes(32).toString('base64url');
			const url = new URL(microsoftAuthority(p) + '/authorize');
			url.search = new URLSearchParams({
				client_id: p.microsoft_client_id!,
				response_type: 'code',
				response_mode: 'query',
				redirect_uri: callbackURI(callback, 'microsoft'),
				scope: scopes.join(' '),
				state,
				code_challenge: createHash('sha256').update(l.verifier).digest('base64url'),
				code_challenge_method: 'S256',
				prompt: 'select_account'
			}).toString();
			l.callback = await CallbackHandoff.create(callback, 'microsoft', state);
			if (l.state !== 'starting') {
				await l.callback.cancel();
				return;
			}
			l.hosted = true;
			l.expires_at = new Date(Date.now() + 10 * 60000).toISOString();
			l.url = url.href;
			l.state = 'awaiting_consent';
			l.message =
				'Sign in with Microsoft, then return here. Your account will connect automatically.';
			return;
		}
		Object.assign(stage, {
			code: 'microsoft_authorization_start',
			message: 'Microsoft sign-in could not start. Check connection setup and try again.'
		});
		const args = [
			'auth',
			'login',
			'--profile',
			selection(a),
			...audience,
			'--scope-workloads',
			a.requested.join(','),
			'--no-input',
			'--json'
		];
		let stderr = '';
		l.child = deviceLogin(
			host.tool(a),
			args,
			host.env(a),
			(chunk) => {
				if (!['starting', 'awaiting_consent'].includes(l.state)) return;
				stderr = (stderr + chunk).slice(-8192);
				const url = stderr.match(
					/https:\/\/(?:www\.)?microsoft\.com\/devicelogin\b|https:\/\/microsoft\.com\/link\b/
				);
				const code = stderr.match(/(?:code\s+)([A-Z0-9-]{6,16})\b/i);
				if (url && code) {
					l.url = url[0];
					l.code = code[1];
					l.state = 'awaiting_consent';
					l.message = 'Open Microsoft sign-in and enter this code.';
				}
			},
			(success) => {
				if (!['starting', 'awaiting_consent'].includes(l.state)) return;
				if (!success) {
					if (ADMIN_APPROVAL.test(stderr)) host.fail(l, ADMIN_MESSAGE, 'admin_approval_required');
					else host.fail(l, 'Sign-in did not complete. Try again.');
					return;
				}
				l.state = 'verifying';
				l.url = null;
				l.code = null;
				void host
					.check(a.id, true)
					.then(() => {
						l.state = 'connected';
						l.message = 'Account connected.';
					})
					.catch(() =>
						host.fail(
							l,
							'Sign-in completed but live identity could not be verified. Check the account and reconnect.'
						)
					);
			}
		);
	},
	async complete(host, l, code) {
		l.state = 'verifying';
		l.url = null;
		const a = host.registry.get(l.account_id);
		const p = provision(host.dir);
		const secret = p.microsoft_client_secret_file
			? readFileSync(p.microsoft_client_secret_file, 'utf8').trim()
			: '';
		const body = new URLSearchParams({
			client_id: p.microsoft_client_id!,
			grant_type: 'authorization_code',
			code,
			redirect_uri: callbackURI(l.callback!.config, 'microsoft'),
			code_verifier: l.verifier!,
			scope: selectionScopes(ui, await host.catalog('microsoft'), a.requested).join(' ')
		});
		if (secret) body.set('client_secret', secret);
		const response = await fetch(microsoftAuthority(p) + '/token', {
			method: 'POST',
			body,
			redirect: 'error',
			signal: AbortSignal.timeout(20000)
		});
		const token = (await response.json()) as {
			refresh_token?: string;
			error_codes?: unknown;
			error_description?: unknown;
		};
		if (
			ADMIN_APPROVAL.test(String(token.error_description)) ||
			(Array.isArray(token.error_codes) &&
				token.error_codes.some((c) => c === 65001 || c === 90094))
		)
			throw new PublicError('admin_approval_required', ADMIN_MESSAGE);
		if (!response.ok || !token.refresh_token) throw new Error('exchange');
		const args = [
			'auth',
			'login',
			'--profile',
			selection(a),
			...(l.prepared as string[]),
			'--scope-workloads',
			a.requested.join(','),
			'--refresh-token-env',
			'FALCON_LINK_LOGIN_REFRESH',
			'--no-input',
			'--json'
		];
		if (secret) args.push('--client-secret-env', 'FALCON_LINK_LOGIN_SECRET');
		await json(
			host.tool(a),
			args,
			{
				...host.env(a),
				FALCON_LINK_LOGIN_REFRESH: token.refresh_token,
				FALCON_LINK_LOGIN_SECRET: secret
			},
			60000
		);
		await host.check(a.id, true);
		l.state = 'connected';
		l.message = 'Account connected.';
	},
	async verify(host, a, completingLogin) {
		// m365cli replaces a profile's account on sign-in; a reconnected profile found in
		// the CLI's own store must still belong to the account it held before.
		const previous =
			completingLogin && a.external && !a.provider_id ? a.email?.toLowerCase() : null;
		const out = await json(
			host.tool(a),
			['--account', selection(a), 'auth', 'check', '--json', '--no-input'],
			host.env(a)
		);
		if (out.verified !== true || out.profile !== selection(a) || !out.identity?.id)
			throw new Error('Identity not verified.');
		if (a.provider_id && a.provider_id !== out.identity.id)
			throw new Error('Account identity changed.');
		if (
			previous &&
			![out.identity.mail, out.identity.userPrincipalName].some(
				(v) => typeof v === 'string' && v.toLowerCase() === previous
			)
		)
			throw new Error('Account identity changed.');
		a.provider_id = out.identity.id;
		a.email = out.identity.mail || out.identity.userPrincipalName || null;
		if (a.external && Array.isArray(out.selected_workloads))
			a.requested = out.selected_workloads.filter((w: unknown) => typeof w === 'string');
		if (!a.email) throw new Error('Provider did not return an account address.');
		if (['consumer', 'enterprise'].includes(out.audience)) a.audience = out.audience;
		// m365cli reads the current Graph grant; `unknown` is never shown as granted.
		const known = out.grant?.status === 'known' && Array.isArray(out.grant.scopes);
		a.granted_scopes = known
			? out.grant.scopes.filter((s: unknown) => typeof s === 'string')
			: null;
		a.grant = {
			status: known ? 'known' : 'unknown',
			selected_not_granted:
				known && Array.isArray(out.grant.selected_not_granted)
					? out.grant.selected_not_granted.filter((s: unknown) => typeof s === 'string')
					: null
		};
		a.recorded_scopes = null;
	},
	async remove(host, a) {
		const tool = host.tool(a);
		const env = host.env(a);
		const profile = selection(a);
		const stored = await json(tool, ['auth', 'status', '--json', '--no-input'], env);
		if (!Array.isArray(stored.profiles))
			throw new Error('Local credential inventory could not be verified.');
		if (stored.profiles.some((p: any) => p.name === profile))
			await json(tool, ['auth', 'logout', '--profile', profile, '--json', '--no-input'], env);
		const after = await json(tool, ['auth', 'status', '--json', '--no-input'], env);
		if (!Array.isArray(after.profiles) || after.profiles.some((p: any) => p.name === profile))
			throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		if (a.external)
			return {
				account: a,
				executable: host.tool(a),
				arguments: ['--account', selection(a)],
				environment: Object.fromEntries(
					STORE.filter((key) => process.env[key] !== undefined).map((key) => [
						key,
						process.env[key]
					])
				),
				inherited_environment: [],
				requested_scopes: [],
				granted_scopes: a.granted_scopes
			};
		const env = host.env(a);
		return {
			account: a,
			executable: host.tool(a),
			arguments: ['--account', a.id],
			environment: Object.fromEntries(STORE.map((k) => [k, env[k]])),
			inherited_environment: [KEYRING],
			granted_scopes: a.granted_scopes
		};
	},
	brief: {
		heading: 'm365cli',
		scopes(a) {
			const values = a.granted_scopes ?? a.recorded_scopes;
			return values?.length ? [...new Set(values)].join('; ') : 'unknown';
		}
	}
};
export default microsoft;
