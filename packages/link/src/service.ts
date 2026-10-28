import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CallbackHandoff, callbackConfig, callbackURI, microsoftAuthority } from './callback.js';
import type { ChildProcess } from 'node:child_process';
import { Registry } from './store.js';
import { existingAccounts } from './discover.js';
import {
	type Account,
	type Catalog,
	type Owner,
	type Provider,
	type Purpose,
	selectionScopes,
	validateMetadata
} from './model.js';
import { googleCatalog, googleCommand, microsoftCatalog, workOnly } from './catalog.js';
import {
	accountEnvironment,
	executable,
	json,
	provision,
	readiness,
	deviceLogin,
	GoogleCompletionError,
	TOOLS
} from './cli.js';
import { install } from './install.js';
import { toolStatus } from './status.js';
import { compareVersions } from './versions.js';

const ADMIN_APPROVAL = /AADSTS(?:65001|90094)\b|\b(?:65001|90094)\b/;
const ADMIN_MESSAGE =
	'Your organization needs an administrator to approve Falcon Link before this account can connect.';
type Login = {
	provider: Provider;
	id: string;
	account_id: string;
	state:
		| 'starting'
		| 'awaiting_consent'
		| 'verifying'
		| 'connected'
		| 'failed'
		| 'cancelled'
		| 'expired';
	expires_at: string;
	url: string | null;
	code: string | null;
	message: string;
	audience: string[];
	email: string;
	child?: ChildProcess;
	args?: string[];
	actor: string;
	callback?: CallbackHandoff;
	verifier?: string;
	consuming?: boolean;
	hosted?: boolean;
	prior: Account | null;
};
export class LinkService {
	readonly registry: Registry;
	private logins = new Map<string, Login>();
	private locks = new Set<string>();
	constructor(readonly dir: string) {
		this.registry = new Registry(dir);
		for (const a of this.registry.list())
			if (a.state === 'pending') {
				a.state = 'failed';
				a.connection_error = {
					code: 'signin_interrupted',
					message: 'Sign-in was interrupted by a restart. Reconnect to start again.'
				};
				this.registry.save(a);
			}
	}
	accounts() {
		return this.registry.list();
	}
	// Permission rows come from each CLI's own catalog, cached until the CLI changes.
	private catalogs = new Map<Provider, Promise<Catalog>>();
	catalog(provider: Provider): Promise<Catalog> {
		let catalog = this.catalogs.get(provider);
		if (!catalog) {
			catalog = json(
				executable(this.dir, provider),
				provider === 'google'
					? ['auth', 'services', '--json', '--no-input']
					: ['auth', 'workloads', '--json', '--no-input'],
				process.env,
				5000
			).then((out) =>
				provider === 'google' ? googleCatalog(out?.services) : microsoftCatalog(out?.workloads)
			);
			this.catalogs.set(provider, catalog);
			catalog.catch(() => this.catalogs.delete(provider));
		}
		return catalog;
	}
	discoveryUnavailable: Provider[] = [];
	private discoveryAt = 0;
	private discovery?: Promise<void>;
	async discover() {
		if (this.discovery) return this.discovery;
		if (Date.now() - this.discoveryAt < 60000) return;
		this.discovery = (async () => {
			this.discoveryUnavailable = [];
			await Promise.all(
				(['google', 'microsoft'] as Provider[]).map(async (provider) => {
					try {
						const found = await existingAccounts(this.dir, provider);
						for (const account of found) {
							const prior = this.accounts().find((a) => a.id === account.id);
							this.registry.save(
								prior
									? {
											...prior,
											recorded_scopes: account.recorded_scopes,
											external: account.external,
											...(account.audience ? { audience: account.audience } : {}),
											requested: account.requested.length ? account.requested : prior.requested,
											state: prior.state === 'disconnected' ? 'discovered' : prior.state
										}
									: account
							);
						}
						for (const prior of this.accounts().filter(
							(a) => a.provider === provider && a.external
						))
							if (!found.some((a) => a.id === prior.id))
								this.registry.save({
									...prior,
									state: 'disconnected',
									recorded_scopes: null,
									granted_scopes: null
								});
					} catch {
						this.discoveryUnavailable.push(provider);
					}
				})
			);
			this.discoveryAt = Date.now();
		})();
		try {
			await this.discovery;
		} finally {
			this.discovery = undefined;
		}
	}
	private selection(a: Account) {
		return a.external?.selection ?? (a.provider === 'google' ? a.email! : a.id);
	}
	private tool(a: Account) {
		return executable(this.dir, a.provider);
	}
	private env(a: Account) {
		if (a.external)
			return {
				...process.env,
				...(a.provider === 'google' && a.external.client ? { GOG_CLIENT: a.external.client } : {}),
				...(a.provider === 'microsoft' && a.external.client_id
					? { M365CLI_CLIENT_ID: a.external.client_id }
					: {})
			};
		return accountEnvironment(this.dir, a.id);
	}
	// Providers accept the hosted redirect only for the provisioned Link client. Accounts in a
	// CLI's own store with another client use that CLI's manual or device-code sign-in.
	private async hostedCallback(a: Account) {
		const callback = callbackConfig(this.dir);
		if (!callback || !a.external) return callback;
		try {
			const p = provision(this.dir);
			if (a.provider === 'microsoft')
				return a.external.client_id === p.microsoft_client_id ? callback : undefined;
			const out = await json(
				this.tool(a),
				['auth', 'credentials', 'list', '--json', '--no-input'],
				this.env(a)
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
	private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
		if (this.locks.has(id)) throw new Error('An account operation is already running.');
		this.locks.add(id);
		try {
			return await fn();
		} finally {
			this.locks.delete(id);
		}
	}
	private publicLogin(l: Login) {
		const {
			child: _c,
			args: _a,
			actor: _actor,
			email: _e,
			audience: _u,
			callback: _cb,
			verifier: _v,
			consuming: _p,
			prior: _prior,
			...result
		} = l;
		return result;
	}
	login(id: string, actor: string) {
		const l = this.logins.get(id);
		if (!l || l.actor !== actor) throw new Error('Login not found. Start a new sign-in.');
		if (
			Date.now() > Date.parse(l.expires_at) &&
			['starting', 'awaiting_consent'].includes(l.state)
		) {
			l.state = 'expired';
			l.url = null;
			l.code = null;
			l.child?.kill();
			void l.callback?.cancel().catch(() => {});
			l.message = 'Sign-in expired. Start again.';
			const a = this.registry.get(l.account_id);
			a.state = 'failed';
			a.connection_error = { code: 'signin_expired', message: l.message };
			this.registry.save(a);
		}
		return this.publicLogin(l);
	}
	async start(
		input: {
			account_id?: string;
			provider: Provider;
			owner: Owner;
			purpose: Purpose;
			permissions: string[];
			email?: string;
		},
		actor: string
	) {
		validateMetadata(input.owner, input.purpose);
		const catalog = await this.catalog(input.provider).catch(() => {
			throw new Error('Permission choices could not be read from the CLI. Try again.');
		});
		const scopes = selectionScopes(input.provider, catalog, input.permissions);
		if (readiness(this.dir, input.provider).state !== 'ready')
			throw new Error('Connection setup is incomplete. Contact your administrator.');
		if (input.provider === 'google' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email ?? ''))
			throw new Error('Enter the Google email address you intend to connect.');
		// m365cli detects the account type itself, except where only work or school accounts
		// qualify or the operator provisioned a tenant.
		const tenant = provision(this.dir).microsoft_tenant;
		const audience =
			tenant || workOnly(catalog, input.permissions)
				? ['--audience', 'enterprise', ...(tenant ? ['--tenant', tenant] : [])]
				: ['--audience', 'auto'];
		// Consent is serialized per provider. Google remote state reuse must not bind a second
		// pending account to the first account's callback.
		for (const l of this.logins.values()) {
			this.login(l.id, l.actor);
			if (
				l.provider === input.provider &&
				['starting', 'awaiting_consent', 'verifying'].includes(l.state)
			)
				throw new Error('Finish or cancel the current sign-in for this integration first.');
		}
		if (this.logins.size >= 100) {
			for (const [id, l] of this.logins)
				if (!['starting', 'awaiting_consent', 'verifying'].includes(l.state))
					this.logins.delete(id);
		}
		const prior = input.account_id ? this.registry.get(input.account_id) : null;
		if (prior && this.locks.has(prior.id))
			throw new Error('An account operation is already running.');
		if (prior && prior.provider !== input.provider)
			throw new Error('Integration does not match the account.');
		if (
			prior?.email &&
			input.provider === 'google' &&
			prior.email.toLowerCase() !== input.email?.toLowerCase()
		)
			throw new Error('Reconnect must use the same account address.');
		const a: Account = {
			id: prior?.id ?? `acct_${randomUUID()}`,
			provider: input.provider,
			owner: input.owner,
			purpose: input.purpose,
			email: prior?.email ?? null,
			provider_id: prior?.provider_id ?? null,
			requested: input.permissions,
			granted_scopes: null,
			...(prior?.audience ? { audience: prior.audience } : {}),
			...(prior?.external ? { external: prior.external } : {}),
			state: 'pending',
			checked_at: null,
			created_at: prior?.created_at ?? new Date().toISOString()
		};
		this.registry.save(a);
		const l: Login = {
			provider: a.provider,
			id: randomUUID(),
			account_id: a.id,
			state: 'starting',
			expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
			url: null,
			code: null,
			message: 'Starting sign-in…',
			audience,
			email: input.email ?? '',
			actor,
			prior
		};
		this.logins.set(l.id, l);
		const callback = await this.hostedCallback(a);
		const tool = this.tool(a);
		const env = this.env(a);
		const name = a.provider === 'google' ? 'Google' : 'Microsoft';
		let failure = {
			code: 'cli_unavailable',
			message: `Install ${TOOLS[a.provider].binary} on this computer to connect ${name} accounts.`
		};
		try {
			const version = await toolStatus(tool);
			if (version.state === 'not_installed') throw new Error('CLI is not installed.');
			if (
				version.state === 'installed' &&
				(compareVersions(version.version, TOOLS[a.provider].minimum) ?? 0) < 0
			) {
				failure = {
					code: 'cli_update_needed',
					message: `Update needed to connect ${name} accounts.`
				};
				throw new Error('CLI is older than the minimum version.');
			}
			if (l.state !== 'starting') return this.publicLogin(l);
			if (a.provider === 'google') {
				failure = {
					code: 'google_client_setup',
					message:
						'Google client configuration could not be loaded into the account store. Contact your administrator.'
				};
				// Accounts found in gog's own store keep that store's OAuth client.
				if (!a.external)
					await json(
						tool,
						[
							'auth',
							'credentials',
							'set',
							provision(this.dir).google_credentials_file!,
							'--json',
							'--no-input'
						],
						env
					);
				const command = googleCommand(catalog, a.requested);
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
				failure = {
					code: 'google_authorization_start',
					message:
						'Google sign-in could not create an authorization URL. Check connection setup and try again.'
				};
				const result = await json(tool, [...args, '--step', '1'], env);
				if (l.state !== 'starting') return this.publicLogin(l);
				const url = new URL(result.auth_url);
				if (
					url.protocol !== 'https:' ||
					url.hostname !== 'accounts.google.com' ||
					!url.searchParams.get('state')
				)
					throw new Error('Provider authorization URL could not be verified.');
				const actual = new Set((url.searchParams.get('scope') ?? '').split(' '));
				const wanted = new Set(command.scopes);
				failure = {
					code: 'google_permission_mismatch',
					message:
						'The Google permission request did not match your selection. No sign-in link was offered.'
				};
				if (actual.size !== wanted.size || [...actual].some((s) => !wanted.has(s)))
					throw new Error('Provider permission request differs from the selection.');
				if (callback) {
					l.callback = await CallbackHandoff.create(
						callback,
						'google',
						url.searchParams.get('state')!
					);
					if (l.state !== 'starting') {
						await l.callback.cancel();
						return this.publicLogin(l);
					}
					l.hosted = true;
					l.expires_at = new Date(Date.now() + 10 * 60000).toISOString();
				}
				l.url = url.href;
				l.state = 'awaiting_consent';
				l.message = callback
					? 'Sign in with Google, then return here. Your account will connect automatically.'
					: 'Sign in with Google. After consent, paste the full redirect URL below; a localhost error in your browser is expected for this remote flow.';
			} else if (callback) {
				failure = {
					code: 'microsoft_authorization_start',
					message:
						'Microsoft sign-in could not start. Check callback service and application setup.'
				};
				const p = provision(this.dir);
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
					return this.publicLogin(l);
				}
				l.hosted = true;
				l.expires_at = new Date(Date.now() + 10 * 60000).toISOString();
				l.url = url.href;
				l.state = 'awaiting_consent';
				l.message =
					'Sign in with Microsoft, then return here. Your account will connect automatically.';
			} else {
				failure = {
					code: 'microsoft_authorization_start',
					message: 'Microsoft sign-in could not start. Check connection setup and try again.'
				};
				const args = [
					'auth',
					'login',
					'--profile',
					this.selection(a),
					...audience,
					'--scope-workloads',
					a.requested.join(','),
					'--no-input',
					'--json'
				];
				let stderr = '';
				l.child = deviceLogin(
					tool,
					args,
					env,
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
							if (ADMIN_APPROVAL.test(stderr))
								this.fail(l, ADMIN_MESSAGE, 'admin_approval_required');
							else this.fail(l, 'Sign-in did not complete. Try again.');
							return;
						}
						l.state = 'verifying';
						l.url = null;
						l.code = null;
						void this.check(a.id, true)
							.then(() => {
								l.state = 'connected';
								l.message = 'Account connected.';
							})
							.catch(() =>
								this.fail(
									l,
									'Sign-in completed but live identity could not be verified. Check the account and reconnect.'
								)
							);
					}
				);
			}
		} catch {
			this.fail(l, failure.message, failure.code);
		}
		return this.publicLogin(l);
	}
	private fail(l: Login, message: string, code = 'signin_failed') {
		if (l.state === 'cancelled') return;
		l.state = 'failed';
		l.url = null;
		l.code = null;
		l.message = message;
		const a = this.registry.get(l.account_id);
		a.state = 'failed';
		a.connection_error = { code, message };
		this.registry.save(a);
	}
	async finish(id: string, redirect: string, actor: string, fromCallback = false) {
		this.login(id, actor);
		const l = this.logins.get(id)!;
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
			const a = this.registry.get(l.account_id);
			const result = await json(
				executable(this.dir, 'google'),
				[...l.args, '--step', '2', '--auth-url', callback.href],
				this.env(a),
				60000
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
			this.registry.save(a);
			failure = {
				code: 'google_identity_check',
				message:
					'Google credentials were saved, but the live identity and refresh check failed. Check the connection or reconnect.'
			};
			await this.check(a.id, true);
			l.state = 'connected';
			l.url = null;
			l.code = null;
			l.message = 'Account connected.';
		} catch (e) {
			if (e instanceof GoogleCompletionError) failure = { code: e.code, message: e.message };
			this.fail(l, failure.message, failure.code);
		}
		return this.publicLogin(l);
	}
	async poll(id: string, actor: string) {
		this.login(id, actor);
		const l = this.logins.get(id)!;
		if (!l.callback || l.state !== 'awaiting_consent' || l.consuming) return this.publicLogin(l);
		l.consuming = true;
		try {
			const result = await l.callback.consume();
			if (l.state !== 'awaiting_consent' || !result) return this.publicLogin(l);
			if (Date.now() >= Date.parse(l.expires_at)) {
				this.login(id, actor);
				return this.publicLogin(l);
			}
			if (result.error || !result.code) throw new Error('consent');
			if (l.provider === 'google') {
				const redirect = new URL(callbackURI(l.callback.config, 'google'));
				redirect.search = new URLSearchParams({
					state: l.callback.state,
					code: result.code
				}).toString();
				return await this.finish(id, redirect.href, actor, true);
			}
			l.state = 'verifying';
			l.url = null;
			const a = this.registry.get(l.account_id);
			const p = provision(this.dir);
			const secret = p.microsoft_client_secret_file
				? readFileSync(p.microsoft_client_secret_file, 'utf8').trim()
				: '';
			const body = new URLSearchParams({
				client_id: p.microsoft_client_id!,
				grant_type: 'authorization_code',
				code: result.code,
				redirect_uri: callbackURI(l.callback.config, 'microsoft'),
				code_verifier: l.verifier!,
				scope: selectionScopes('microsoft', await this.catalog('microsoft'), a.requested).join(' ')
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
			if (ADMIN_APPROVAL.test(JSON.stringify([token.error_codes, token.error_description])))
				throw new Error(ADMIN_MESSAGE);
			if (!response.ok || !token.refresh_token) throw new Error('exchange');
			const args = [
				'auth',
				'login',
				'--profile',
				this.selection(a),
				...l.audience,
				'--scope-workloads',
				a.requested.join(','),
				'--refresh-token-env',
				'FALCON_LINK_LOGIN_REFRESH',
				'--no-input',
				'--json'
			];
			if (secret) args.push('--client-secret-env', 'FALCON_LINK_LOGIN_SECRET');
			await json(
				this.tool(a),
				args,
				{
					...this.env(a),
					FALCON_LINK_LOGIN_REFRESH: token.refresh_token,
					FALCON_LINK_LOGIN_SECRET: secret
				},
				60000
			);
			await this.check(a.id, true);
			l.state = 'connected';
			l.message = 'Account connected.';
		} catch (e) {
			if (['awaiting_consent', 'verifying'].includes(l.state))
				if ((e as Error).message === ADMIN_MESSAGE)
					this.fail(l, ADMIN_MESSAGE, 'admin_approval_required');
				else
					this.fail(
						l,
						'Sign-in did not complete. Try again, or contact your administrator if it keeps failing.',
						'callback_completion_failed'
					);
		} finally {
			l.consuming = false;
			if (l.state !== 'awaiting_consent') {
				l.callback = undefined;
				l.verifier = undefined;
			}
		}
		return this.publicLogin(l);
	}

	cancel(id: string, actor: string) {
		this.login(id, actor);
		const l = this.logins.get(id)!;
		if (l.state === 'verifying') throw new Error('Identity verification is in progress.');
		if (['starting', 'awaiting_consent'].includes(l.state)) {
			l.state = 'cancelled';
			l.child?.kill();
			void l.callback?.cancel().catch(() => {});
			l.url = null;
			l.code = null;
			l.message = 'You cancelled sign-in. Nothing changed.';
			// The account returns to exactly what it was; a new account is not kept.
			if (l.prior) this.registry.save(l.prior);
			else {
				this.registry.remove(l.account_id);
				if (/^acct_[a-f0-9-]{36}$/.test(l.account_id))
					rmSync(path.join(this.dir, 'accounts', l.account_id), { recursive: true, force: true });
			}
		}
		return this.publicLogin(l);
	}
	async check(id: string, completingLogin = false) {
		if (
			!completingLogin &&
			[...this.logins.values()].some(
				(l) =>
					l.account_id === id && ['starting', 'awaiting_consent', 'verifying'].includes(l.state)
			)
		)
			throw new Error('Finish or cancel sign-in before checking this connection.');
		return this.locked(id, async () => {
			const a = this.registry.get(id);
			if (a.state === 'disconnected') throw new Error('Account is disconnected.');
			try {
				if (a.provider === 'google') {
					const out = await json(
						this.tool(a),
						['auth', 'list', '--check', '--json', '--no-input'],
						this.env(a)
					);
					const entry = out.accounts?.find(
						(e: any) =>
							e.email?.toLowerCase() === a.email?.toLowerCase() &&
							(!a.external || (e.client ?? 'default') === (a.external.client ?? 'default'))
					);
					if (!entry || entry.valid !== true || !entry.subject)
						throw new Error('Identity not verified.');
					if (a.provider_id && a.provider_id !== entry.subject)
						throw new Error('Account identity changed.');
					a.provider_id = entry.subject;
					a.granted_scopes = null;
					a.recorded_scopes = Array.isArray(entry.scopes)
						? entry.scopes.filter((s: unknown) => typeof s === 'string')
						: null;
					// gog reports scopes from stored token metadata; do not promote them to verified grants.
				} else {
					// m365cli replaces a profile's account on sign-in; a reconnected profile found in
					// the CLI's own store must still belong to the account it held before.
					const previous =
						completingLogin && a.external && !a.provider_id ? a.email?.toLowerCase() : null;
					const out = await json(
						this.tool(a),
						['--account', this.selection(a), 'auth', 'check', '--json', '--no-input'],
						this.env(a)
					);
					if (out.verified !== true || out.profile !== this.selection(a) || !out.identity?.id)
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
				}
				a.owner = this.registry.get(id).owner;
				a.purpose = this.registry.get(id).purpose;
				a.state = 'connected';
				delete a.connection_error;
				a.checked_at = new Date().toISOString();
				this.registry.save(a);
				return a;
			} catch {
				a.owner = this.registry.get(id).owner;
				a.purpose = this.registry.get(id).purpose;
				a.state = 'check_failed';
				a.connection_error = {
					code: 'identity_check_failed',
					message:
						'The live identity and refresh check failed. Reconnect if consent has expired or been revoked.'
				};
				a.checked_at = new Date().toISOString();
				this.registry.save(a);
				throw new Error(
					'Live identity check failed. Reconnect if consent has expired or been revoked.'
				);
			}
		});
	}
	async disconnect(id: string) {
		return this.locked(id, async () => {
			const a = this.registry.get(id);
			if (a.state === 'disconnected') return a;
			if (
				[...this.logins.values()].some(
					(l) =>
						l.account_id === id && ['starting', 'awaiting_consent', 'verifying'].includes(l.state)
				)
			)
				throw new Error('Finish or cancel sign-in before disconnecting.');
			// Only this account's CLI-native encrypted credentials are removed. Never revoke provider-wide consent.
			const tool = this.tool(a);
			const env = this.env(a);
			// A CLI's own store keeps every other account; Link's isolated store holds only this one.
			const same = (e: any) =>
				typeof e?.email === 'string' &&
				e.email.toLowerCase() === a.email?.toLowerCase() &&
				(e.client ?? 'default') === (a.external?.client ?? 'default');
			if (a.provider === 'google') {
				const stored = await json(tool, ['auth', 'list', '--json', '--no-input'], env);
				if (!Array.isArray(stored.accounts))
					throw new Error('Local credential inventory could not be verified.');
				for (const entry of a.external ? stored.accounts.filter(same) : stored.accounts) {
					if (typeof entry.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email))
						throw new Error('Local account identity is unavailable.');
					await json(tool, ['auth', 'remove', entry.email, '--force', '--json', '--no-input'], env);
				}
			} else {
				const stored = await json(tool, ['auth', 'status', '--json', '--no-input'], env);
				if (!Array.isArray(stored.profiles))
					throw new Error('Local credential inventory could not be verified.');
				const profile = this.selection(a);
				if (stored.profiles.some((p: any) => p.name === profile))
					await json(tool, ['auth', 'logout', '--profile', profile, '--json', '--no-input'], env);
			}

			const after = await json(
				tool,
				a.provider === 'google'
					? ['auth', 'list', '--json', '--no-input']
					: ['auth', 'status', '--json', '--no-input'],
				env
			);
			if (
				a.provider === 'google'
					? !Array.isArray(after.accounts) ||
						(a.external ? after.accounts.some(same) : after.accounts.length !== 0)
					: !Array.isArray(after.profiles) ||
						after.profiles.some((p: any) => p.name === this.selection(a))
			)
				throw new Error('Local credential removal could not be verified.');

			a.state = 'disconnected';
			delete a.connection_error;
			a.granted_scopes = null;
			a.recorded_scopes = null;
			this.registry.save(a);
			return a;
		});
	}
	metadata(id: string, owner: Owner, purpose: Purpose) {
		validateMetadata(owner, purpose);
		const a = this.registry.get(id);
		a.owner = owner;
		a.purpose = purpose;
		this.registry.save(a);
		return a;
	}
	async invocation(id: string) {
		const a = this.registry.get(id);
		if (!['connected', 'discovered'].includes(a.state) || !a.email)
			throw new Error('Account is not connected.');
		if (a.external)
			return {
				account: a,
				executable: this.tool(a),
				arguments: [
					...(a.external.client ? ['--client', a.external.client] : []),
					'--account',
					this.selection(a)
				],
				environment: Object.fromEntries(
					[
						...(a.provider === 'google'
							? [
									'GOG_CONFIG_DIR',
									'GOG_DATA_DIR',
									'GOG_STATE_DIR',
									'GOG_CACHE_DIR',
									'GOG_KEYRING_BACKEND'
								]
							: ['M365CLI_CONFIG_DIR', 'M365CLI_KEYRING_BACKEND'])
					]
						.filter((key) => process.env[key] !== undefined)
						.map((key) => [key, process.env[key]])
				),
				inherited_environment: [],
				requested_scopes: [],
				granted_scopes: a.granted_scopes
			};
		const env = this.env(a);
		// Normal exec protects HOME/XDG launch context. Select the existing store through
		// each CLI's own supported settings, without changing the process home.
		const names =
			a.provider === 'google'
				? [
						'GOG_CONFIG_DIR',
						'GOG_DATA_DIR',
						'GOG_STATE_DIR',
						'GOG_CACHE_DIR',
						'GOG_KEYRING_BACKEND'
					]
				: ['M365CLI_CONFIG_DIR', 'M365CLI_KEYRING_BACKEND'];
		return {
			account: a,
			executable: this.tool(a),
			arguments: ['--account', a.provider === 'google' ? a.email : a.id],
			environment: Object.fromEntries(
				names
					.filter((k) => a.provider === 'google' || !k.startsWith('GOG_'))
					.map((k) => [k, env[k]])
			),
			inherited_environment: [
				a.provider === 'google' ? 'GOG_KEYRING_PASSWORD' : 'M365CLI_KEYRING_PASSWORD'
			],
			requested_scopes: await this.catalog(a.provider)
				.then((c) => selectionScopes(a.provider, c, a.requested))
				.catch(() => null),
			granted_scopes: a.granted_scopes
		};
	}
	async install(provider: Provider) {
		if (
			[...this.logins.values()].some(
				(l) =>
					l.provider === provider && ['starting', 'awaiting_consent', 'verifying'].includes(l.state)
			)
		)
			throw new Error('Finish or cancel sign-in before changing the CLI.');
		try {
			return await install(this.dir, provider);
		} finally {
			this.catalogs.delete(provider);
		}
	}
	stop() {
		for (const l of this.logins.values()) {
			if (['starting', 'awaiting_consent'].includes(l.state)) {
				l.state = 'cancelled';
				l.child?.kill();
			}
		}
	}
}
