import { readFileSync } from 'node:fs';
import { CallbackHandoff, callbackConfig, callbackURI } from '../../callback.js';
import { googleCatalog, googleCommand } from './catalog.js';
import { isolatedEnvironment, json, keyringPassword, provision } from '../../cli.js';
import { existingId, inventory, validEmail, validSelection } from '../../discover.js';
import type { Account } from '../../model.js';
import { PublicError, type Host, type ProviderModule } from '../types.js';
import ui from './ui.js';

const KEYRING = 'GOG_KEYRING_PASSWORD';
const STORE = [
	'GOG_CONFIG_DIR',
	'GOG_DATA_DIR',
	'GOG_STATE_DIR',
	'GOG_CACHE_DIR',
	'GOG_KEYRING_BACKEND'
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Compact scope labels for the agents' account brief.
const BRIEF: Record<string, string> = {
	'gmail.readonly': 'Gmail: read',
	'gmail.send': 'Gmail: send',
	'gmail.compose': 'Gmail: drafts/send',
	'gmail.modify': 'Gmail: read/modify/send',
	'calendar.readonly': 'Calendar: read',
	calendar: 'Calendar: read/write',
	'drive.readonly': 'Drive: read',
	drive: 'Drive: read/write',
	'drive.file': 'Drive: app-selected files',
	'contacts.readonly': 'Contacts: read',
	'contacts.other.readonly': 'Other contacts: read',
	'directory.readonly': 'Directory: read',
	contacts: 'Contacts: read/write',
	spreadsheets: 'Sheets: read/write',
	documents: 'Docs: read/write',
	'gmail.settings.basic': 'Gmail: manage basic settings',
	'gmail.settings.sharing': 'Gmail: manage sharing settings',
	email: 'Identity: email',
	openid: 'Identity: OpenID',
	'userinfo.email': 'Identity: email',
	'userinfo.profile': 'Identity: profile'
};
const short = (s: string) => s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');

// Only recognized gog stage markers become public facts. Never retain raw stderr,
// which can contain addresses, codes, tokens or provider diagnostic payloads.
function completionError(stderr: string): PublicError | undefined {
	const stages = [
		[
			'OAuth completed, but saving the refresh token failed:',
			'google_token_storage_failed',
			'Google authorization completed, but the encrypted account store could not save the connection. Contact your administrator before reconnecting.'
		],
		[
			'fetch authorized email:',
			'google_identity_failed',
			'Google authorization completed, but the account identity could not be confirmed. Reconnect to try again.'
		],
		[
			'authorized as ',
			'google_account_mismatch',
			'Google returned a different account address. Reconnect with the intended account.'
		],
		[
			'exchange code:',
			'google_exchange_failed',
			'Google could not exchange the authorization code. Reconnect and complete a new sign-in.'
		]
	] as const;
	for (const [marker, code, message] of stages)
		if (stderr.includes(marker)) return new PublicError(code, message);
	return undefined;
}
const selection = (a: Account) => a.external?.selection ?? a.email!;
// Providers accept the hosted redirect only for the provisioned Link client. Accounts in
// gog's own store with another client use the manual flow.
async function hostedCallback(host: Host, a: Account) {
	const callback = callbackConfig(host.dir);
	if (!callback || !a.external) return callback;
	try {
		const p = provision(host.dir);
		const out = await json(
			host.tool(a),
			['auth', 'credentials', 'list', '--json', '--no-input'],
			host.env(a)
		);
		const entry = out?.clients?.find((c: any) => c?.client === (a.external!.client ?? 'default'));
		const stored = JSON.parse(readFileSync(entry.path, 'utf8'));
		const link = JSON.parse(readFileSync(p.google_credentials_file!, 'utf8')).web?.client_id;
		const id = stored.client_id ?? stored.web?.client_id ?? stored.installed?.client_id;
		return link && id === link ? callback : undefined;
	} catch {
		return undefined;
	}
}

const google: ProviderModule = {
	ui,
	tool: {
		binary: 'gog',
		// gogcli CHANGELOG 0.44.0: "Photos: upload media and list/create app-created albums with an
		// explicit append-scope opt-in" — Link passes `--photos-scope append`.
		minimum: '0.44.0',
		source: { kind: 'github', repo: 'openclaw/gogcli', archive: 'gogcli' }
	},
	methods: ['hosted_callback', 'paste_redirect'],
	readiness(dir) {
		const p = provision(dir);
		let ready = !!keyringPassword(KEYRING);
		try {
			const raw = JSON.parse(readFileSync(p.google_credentials_file ?? '', 'utf8'));
			const c = p.callback ? raw.web : raw.installed;
			ready = ready && !!c?.client_id && !!c?.client_secret;
		} catch {
			ready = false;
		}
		return {
			state: ready ? 'ready' : 'setup_required',
			message: ready
				? ''
				: "Google sign-in isn't set up on this Office. Contact your administrator."
		};
	},
	async catalog(tool) {
		const out = await json(tool, ['auth', 'services', '--json', '--no-input'], process.env, 5000);
		return googleCatalog(out?.services);
	},
	async discover(tool) {
		const out = await json(tool, ['auth', 'list', '--json', '--no-input'], process.env, 5000);
		const accounts: Account[] = [];
		for (const entry of inventory(out.accounts)) {
			const email = entry.email;
			if (!validEmail(email)) continue;
			const client = entry.client ?? 'default';
			if (
				typeof client !== 'string' ||
				!/^[a-zA-Z0-9_.-]{1,128}$/.test(client) ||
				client.startsWith('-') ||
				!validSelection(email)
			)
				continue;
			accounts.push({
				id: existingId([
					'google',
					process.env.HOME,
					process.env.XDG_CONFIG_HOME,
					process.env.GOG_CONFIG_DIR,
					process.env.GOG_DATA_DIR,
					email,
					client
				]),
				provider: 'google',
				email,
				owner: null,
				purpose: null,
				provider_id: null,
				requested: [],
				recorded_scopes: Array.isArray(entry.scopes)
					? entry.scopes
							.filter((s: unknown): s is string => typeof s === 'string' && s.length <= 512)
							.slice(0, 100)
					: null,
				granted_scopes: null,
				state: 'discovered',
				checked_at: null,
				created_at: new Date().toISOString(),
				external: { selection: email, client }
			});
		}
		return accounts;
	},
	environment(dir, a) {
		if (a.external)
			return { ...process.env, ...(a.external.client ? { GOG_CLIENT: a.external.client } : {}) };
		const env = isolatedEnvironment(dir, a.id);
		const home = env.HOME!;
		Object.assign(env, {
			GOG_CONFIG_DIR: `${home}/gog`,
			GOG_DATA_DIR: `${home}/gog-data`,
			GOG_STATE_DIR: `${home}/gog-state`,
			GOG_CACHE_DIR: `${home}/gog-cache`,
			GOG_KEYRING_BACKEND: 'file',
			GOG_KEYRING_PASSWORD: keyringPassword(KEYRING)
		});
		// Do not inherit account/client selection or service-account overrides from the host.
		for (const key of ['GOG_ACCOUNT', 'GOG_CLIENT', 'GOG_HOME', 'GOOGLE_APPLICATION_CREDENTIALS'])
			delete env[key];
		return env;
	},
	validate(input, prior) {
		if (!EMAIL.test(input.email ?? ''))
			throw new Error('Enter the Google email address you intend to connect.');
		if (prior?.email && prior.email.toLowerCase() !== input.email?.toLowerCase())
			throw new Error('Reconnect must use the same account address.');
	},
	async start(host, l, a, stage) {
		const callback = await hostedCallback(host, a);
		const tool = host.tool(a);
		const env = host.env(a);
		Object.assign(stage, {
			code: 'google_client_setup',
			message:
				'Google client configuration could not be loaded into the account store. Contact your administrator.'
		});
		// Accounts found in gog's own store keep that store's OAuth client.
		if (!a.external)
			await json(
				tool,
				[
					'auth',
					'credentials',
					'set',
					provision(host.dir).google_credentials_file!,
					'--json',
					'--no-input'
				],
				env
			);
		const command = googleCommand(await host.catalog('google'), a.requested);
		const args = [
			'auth',
			'add',
			l.email,
			...command.args,
			'--remote',
			'--force-consent',
			'--json',
			'--no-input'
		];
		if (callback) args.push('--redirect-uri', callbackURI(callback, 'google'));
		l.args = args;
		Object.assign(stage, {
			code: 'google_authorization_start',
			message:
				'Google sign-in could not create an authorization URL. Check connection setup and try again.'
		});
		const result = await json(tool, [...args, '--step', '1'], env);
		if (l.state !== 'starting') return;
		const url = new URL(result.auth_url);
		if (
			url.protocol !== 'https:' ||
			url.hostname !== 'accounts.google.com' ||
			!url.searchParams.get('state')
		)
			throw new Error('Provider authorization URL could not be verified.');
		const actual = new Set((url.searchParams.get('scope') ?? '').split(' '));
		const wanted = new Set(command.scopes);
		Object.assign(stage, {
			code: 'google_permission_mismatch',
			message:
				'The Google permission request did not match your selection. No sign-in link was offered.'
		});
		if (actual.size !== wanted.size || [...actual].some((s) => !wanted.has(s)))
			throw new Error('Provider permission request differs from the selection.');
		if (callback) {
			l.callback = await CallbackHandoff.create(callback, 'google', url.searchParams.get('state')!);
			if (l.state !== 'starting') {
				await l.callback.cancel();
				return;
			}
			l.hosted = true;
			l.expires_at = new Date(Date.now() + 10 * 60000).toISOString();
		} else l.paste = { label: 'Address shown in your browser after signing in', kind: 'url' };
		l.url = url.href;
		l.state = 'awaiting_consent';
		l.message = callback
			? 'Sign in with Google, then return here. Your account will connect automatically.'
			: 'Sign in with Google. After consent, paste the full redirect URL below; a localhost error in your browser is expected for this remote flow.';
	},
	async finish(host, l, redirect, fromCallback) {
		if (l.state !== 'awaiting_consent' || !l.args)
			throw new Error('This sign-in is not waiting for a Google redirect.');
		if (l.hosted && !fromCallback) throw new Error('This sign-in completes automatically.');
		const callback = new URL(redirect);
		const expected = new URL(l.url!);
		const target = new URL(expected.searchParams.get('redirect_uri')!);
		if (
			callback.origin !== target.origin ||
			callback.pathname !== target.pathname ||
			callback.searchParams.get('state') !== expected.searchParams.get('state') ||
			!callback.searchParams.get('code')
		)
			throw new Error('Redirect URL or sign-in state does not match.');
		l.state = 'verifying';
		let failure = {
			code: 'google_completion_failed',
			message:
				'Google sign-in could not complete authorization, identity confirmation or credential storage. Reconnect to start a new sign-in.'
		};
		try {
			const a = host.registry.get(l.account_id);
			const result = await json(
				host.tool(a),
				[...l.args, '--step', '2', '--auth-url', callback.href],
				host.env(a),
				60000,
				completionError
			);
			failure = {
				code: 'google_account_mismatch',
				message:
					'Google did not confirm the intended account address. Reconnect using that account.'
			};
			if (
				result.stored !== true ||
				typeof result.email !== 'string' ||
				result.email.toLowerCase() !== l.email.toLowerCase()
			)
				throw new Error('Provider returned a different account.');
			a.email = result.email;
			host.registry.save(a);
			failure = {
				code: 'google_identity_check',
				message:
					'Google credentials were saved, but the live identity and refresh check failed. Check the connection or reconnect.'
			};
			await host.check(a.id, true);
			l.state = 'connected';
			l.url = null;
			l.code = null;
			l.message = 'Account connected.';
		} catch (e) {
			if (e instanceof PublicError) failure = { code: e.code, message: e.message };
			host.fail(l, failure.message, failure.code);
		}
	},
	async complete(host, l, code) {
		const redirect = new URL(callbackURI(l.callback!.config, 'google'));
		redirect.search = new URLSearchParams({ state: l.callback!.state, code }).toString();
		await host.finish(l.id, redirect.href, l.actor, true);
	},
	async verify(host, a) {
		const out = await json(
			host.tool(a),
			['auth', 'list', '--check', '--json', '--no-input'],
			host.env(a)
		);
		const entry = out.accounts?.find(
			(e: any) =>
				e.email?.toLowerCase() === a.email?.toLowerCase() &&
				(!a.external || (e.client ?? 'default') === (a.external.client ?? 'default'))
		);
		if (!entry || entry.valid !== true || !entry.subject) throw new Error('Identity not verified.');
		if (a.provider_id && a.provider_id !== entry.subject)
			throw new Error('Account identity changed.');
		a.provider_id = entry.subject;
		a.granted_scopes = null;
		// gog reports scopes from stored token metadata; do not promote them to verified grants.
		a.recorded_scopes = Array.isArray(entry.scopes)
			? entry.scopes.filter((s: unknown) => typeof s === 'string')
			: null;
	},
	async remove(host, a) {
		const tool = host.tool(a);
		const env = host.env(a);
		// gog's own store keeps every other account; Link's isolated store holds only this one.
		const same = (e: any) =>
			typeof e?.email === 'string' &&
			e.email.toLowerCase() === a.email?.toLowerCase() &&
			(e.client ?? 'default') === (a.external?.client ?? 'default');
		const stored = await json(tool, ['auth', 'list', '--json', '--no-input'], env);
		if (!Array.isArray(stored.accounts))
			throw new Error('Local credential inventory could not be verified.');
		for (const entry of a.external ? stored.accounts.filter(same) : stored.accounts) {
			if (typeof entry.email !== 'string' || !EMAIL.test(entry.email))
				throw new Error('Local account identity is unavailable.');
			await json(tool, ['auth', 'remove', entry.email, '--force', '--json', '--no-input'], env);
		}
		const after = await json(tool, ['auth', 'list', '--json', '--no-input'], env);
		if (
			!Array.isArray(after.accounts) ||
			(a.external ? after.accounts.some(same) : after.accounts.length !== 0)
		)
			throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		if (a.external)
			return {
				account: a,
				executable: host.tool(a),
				arguments: [
					...(a.external.client ? ['--client', a.external.client] : []),
					'--account',
					selection(a)
				],
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
		// Normal exec protects HOME/XDG launch context. Select the isolated store through
		// gog's own settings, without changing the process home.
		const env = host.env(a);
		return {
			account: a,
			executable: host.tool(a),
			arguments: ['--account', a.email],
			environment: Object.fromEntries(STORE.map((k) => [k, env[k]])),
			inherited_environment: [KEYRING],
			granted_scopes: a.granted_scopes
		};
	},
	brief: {
		heading: 'gogcli',
		scopes(a) {
			const values = a.granted_scopes ?? a.recorded_scopes;
			if (!values?.length) return 'unknown';
			return [...new Set(values.map((s) => BRIEF[short(s)] ?? short(s)))].join('; ');
		}
	}
};
export default google;
