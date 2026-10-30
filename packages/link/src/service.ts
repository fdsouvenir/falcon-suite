import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Registry } from './store.js';
import {
	type Account,
	type Catalog,
	type Owner,
	type Purpose,
	selectionScopes,
	validateMetadata
} from './model.js';
import { accountHome } from './cli.js';
import { executable } from './tools.js';
import { install } from './install.js';
import { followTool, installSkills, removeSkills } from './skills.js';
import { toolStatus } from './status.js';
import { compareVersions } from './versions.js';
import { PROVIDERS, provider } from './providers/index.js';
import {
	PublicError,
	type Host,
	type KeyInput,
	type Login,
	type StartInput,
	type Stage
} from './providers/types.js';

const ACTIVE = ['starting', 'awaiting_consent', 'verifying'];
export class LinkService implements Host {
	readonly registry: Registry;
	private logins = new Map<string, Login>();
	private watchers = new Set<ReturnType<typeof setTimeout>>();
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
	private catalogs = new Map<string, Promise<Catalog>>();
	catalog(id: string): Promise<Catalog> {
		let catalog = this.catalogs.get(id);
		if (!catalog) {
			const p = provider(id);
			if (!p.catalog) return Promise.reject(new Error('This integration has no permission list.'));
			catalog = p.catalog(executable(this.dir, id));
			this.catalogs.set(id, catalog);
			catalog.catch(() => this.catalogs.delete(id));
		}
		return catalog;
	}
	discoveryUnavailable: string[] = [];
	private discoveryAt = 0;
	private discovery?: Promise<void>;
	async discover() {
		if (this.discovery) return this.discovery;
		if (Date.now() - this.discoveryAt < 60000) return;
		this.discovery = (async () => {
			this.discoveryUnavailable = [];
			await Promise.all(
				PROVIDERS.map(async (p) => {
					const id = p.ui.id;
					try {
						const found = await p.discover(
							executable(this.dir, id),
							this.accounts().filter((a) => a.provider === id)
						);
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
						for (const prior of this.accounts().filter((a) => a.provider === id && a.external))
							if (!found.some((a) => a.id === prior.id))
								this.registry.save({
									...prior,
									state: 'disconnected',
									recorded_scopes: null,
									granted_scopes: null
								});
					} catch {
						this.discoveryUnavailable.push(id);
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
	tool(a: Account) {
		return executable(this.dir, a.provider);
	}
	env(a: Account) {
		return provider(a.provider).environment(this.dir, a);
	}
	// A missing CLI, or one older than the version Link relies on, stops sign-in.
	private async cliProblem(id: string) {
		const p = provider(id);
		const version = await toolStatus(
			executable(this.dir, id),
			p.tool.version_prefix,
			p.tool.version_args
		);
		if (version.state === 'not_installed')
			return `Install ${p.tool.binary} on this computer to connect ${p.ui.name} accounts.`;
		if (
			version.state === 'installed' &&
			(compareVersions(version.version, p.tool.minimum) ?? 0) < 0
		)
			return `Update needed to connect ${p.ui.name} accounts.`;
		return null;
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
			prepared: _p,
			callback: _cb,
			verifier: _v,
			consuming: _consuming,
			prior: _prior,
			...result
		} = l;
		// Gateway feature output must be plain JSON; cleared fields are undefined.
		return JSON.parse(JSON.stringify(result));
	}
	private active(id: string) {
		return [...this.logins.values()].some((l) => l.account_id === id && ACTIVE.includes(l.state));
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
	// Checks shared by every way of connecting; returns the account being reconnected, if any.
	private claim(providerId: string, accountId: string | undefined) {
		// Consent is serialized per provider. Google remote state reuse must not bind a second
		// pending account to the first account's callback.
		for (const l of this.logins.values()) {
			this.login(l.id, l.actor);
			if (l.provider !== providerId || !ACTIVE.includes(l.state)) continue;
			if (l.state === 'verifying')
				throw new Error('Finish or cancel the current sign-in for this integration first.');
			// Starting again replaces a sign-in still waiting on the provider (for example one the
			// provider refused on its own page, which never returns here).
			if (l.account_id === accountId) {
				l.state = 'cancelled';
				l.child?.kill();
				void l.callback?.cancel().catch(() => {});
				l.url = null;
				l.code = null;
				l.paste = undefined;
			} else this.cancel(l.id, l.actor);
		}
		if (this.logins.size >= 100) {
			for (const [id, l] of this.logins) if (!ACTIVE.includes(l.state)) this.logins.delete(id);
		}
		const prior = accountId ? this.registry.get(accountId) : null;
		if (prior && this.locks.has(prior.id))
			throw new Error('An account operation is already running.');
		if (prior && prior.provider !== providerId)
			throw new Error('Integration does not match the account.');
		return prior;
	}
	async start(input: StartInput, actor: string) {
		validateMetadata(input.owner, input.purpose);
		const p = provider(input.provider);
		const setup = p.readiness(this.dir);
		if (setup.state !== 'ready') throw new Error(setup.message);
		p.validate?.(input, null);
		let catalog: Catalog | null = null;
		if (p.catalog) {
			catalog = await this.catalog(input.provider).catch(async () => {
				throw new Error(
					(await this.cliProblem(input.provider)) ??
						'Permission choices could not be read from the CLI. Try again.'
				);
			});
			selectionScopes(p.ui, catalog, input.permissions);
		} else if (input.permissions.length) throw new Error('Select supported permissions.');
		const prepared = p.prepare?.(this.dir, input, catalog);
		const prior = this.claim(input.provider, input.account_id);
		if (prior) p.validate?.(input, prior);
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
			...(prior?.auth ? { auth: 'oauth' as const } : {}),
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
			prepared,
			email: input.email ?? '',
			actor,
			prior
		};
		this.logins.set(l.id, l);
		const stage: Stage = { code: 'cli_unavailable', message: '' };
		try {
			const problem = await this.cliProblem(a.provider);
			if (problem) {
				Object.assign(stage, {
					code: problem.startsWith('Update') ? 'cli_update_needed' : 'cli_unavailable',
					message: problem
				});
				throw new Error(problem);
			}
			if (l.state !== 'starting') return this.publicLogin(l);
			await p.start(this, l, a, stage);
		} catch (e) {
			if (e instanceof PublicError) this.fail(l, e.message, e.code);
			else this.fail(l, stage.message, stage.code);
		}
		this.watch(l);
		return this.publicLogin(l);
	}
	fail(l: Login, message: string, code = 'signin_failed') {
		if (l.state === 'cancelled') return;
		l.state = 'failed';
		l.url = null;
		l.code = null;
		l.paste = undefined;
		l.message = message;
		const a = this.registry.get(l.account_id);
		a.state = 'failed';
		a.connection_error = { code, message };
		this.registry.save(a);
	}
	async finish(id: string, value: string, actor: string, fromCallback = false) {
		this.login(id, actor);
		const l = this.logins.get(id)!;
		const p = provider(l.provider);
		if (!p.finish || l.state !== 'awaiting_consent')
			throw new Error('This sign-in is not waiting for a pasted address or code.');
		await p.finish(this, l, value, fromCallback);
		if (l.state !== 'awaiting_consent') l.paste = undefined;
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
			await provider(l.provider).complete!(this, l, result.code);
		} catch (e) {
			if (['awaiting_consent', 'verifying'].includes(l.state))
				if (e instanceof PublicError) this.fail(l, e.message, e.code);
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
	// Connects with a pasted key instead of a sign-in. The key goes only to the account's own
	// CLI store; it is never saved in the account list, returned or logged.
	async connectKey(input: KeyInput) {
		validateMetadata(input.owner, input.purpose);
		const p = provider(input.provider);
		if (!p.connectKey) throw new Error('This integration does not connect with a key.');
		const setup = p.readiness(this.dir);
		if (setup.state !== 'ready') throw new Error(setup.message);
		const prior = this.claim(input.provider, input.account_id);
		if (prior && prior.auth !== 'service_key')
			throw new Error('This account signs in with the provider; reconnect it instead.');
		const problem = await this.cliProblem(input.provider);
		if (problem) throw new Error(problem);
		const id = prior?.id ?? `acct_${randomUUID()}`;
		return this.locked(id, async () => {
			const a: Account = {
				id,
				provider: input.provider,
				owner: input.owner,
				purpose: input.purpose,
				email: null,
				provider_id: prior?.provider_id ?? null,
				requested: [],
				granted_scopes: null,
				auth: 'service_key',
				state: 'pending',
				checked_at: null,
				created_at: prior?.created_at ?? new Date().toISOString()
			};
			try {
				await p.connectKey!(this, a, input.key, prior);
			} catch (e) {
				if (prior) this.registry.save(prior);
				else {
					this.registry.remove(id);
					rmSync(accountHome(this.dir, id), { recursive: true, force: true });
				}
				throw e instanceof PublicError
					? e
					: new Error('The key could not be checked with the provider. Try again.');
			}
			a.state = 'connected';
			a.checked_at = new Date().toISOString();
			delete a.connection_error;
			this.registry.save(a);
			return a;
		});
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
			l.paste = undefined;
			l.message = 'You cancelled sign-in. Nothing changed.';
			// The account returns to exactly what it was; a new account is not kept.
			if (l.prior) this.registry.save(l.prior);
			else {
				this.registry.remove(l.account_id);
				if (/^acct_[a-f0-9-]{36}$/.test(l.account_id))
					rmSync(accountHome(this.dir, l.account_id), { recursive: true, force: true });
			}
		}
		return this.publicLogin(l);
	}
	async check(id: string, completingLogin = false) {
		if (!completingLogin && this.active(id))
			throw new Error('Finish or cancel sign-in before checking this connection.');
		return this.locked(id, async () => {
			const a = this.registry.get(id);
			if (a.state === 'disconnected') throw new Error('Account is disconnected.');
			try {
				await provider(a.provider).verify(this, a, completingLogin);
				a.owner = this.registry.get(id).owner;
				a.purpose = this.registry.get(id).purpose;
				a.state = 'connected';
				delete a.connection_error;
				a.checked_at = new Date().toISOString();
				this.registry.save(a);
				return a;
			} catch (e) {
				const known = e instanceof PublicError;
				a.owner = this.registry.get(id).owner;
				a.purpose = this.registry.get(id).purpose;
				a.state = 'check_failed';
				a.connection_error = known
					? { code: e.code, message: e.message }
					: {
							code: 'identity_check_failed',
							message:
								'The live identity and refresh check failed. Reconnect if consent has expired or been revoked.'
						};
				a.checked_at = new Date().toISOString();
				this.registry.save(a);
				if (known) throw e;
				throw new Error(
					'Live identity check failed. Reconnect if consent has expired or been revoked.'
				);
			}
		});
	}
	async remove(id: string) {
		return this.locked(id, async () => {
			const a = this.registry.get(id);
			const forget = () => {
				this.registry.remove(id);
				if (!a.external && /^acct_[a-f0-9-]{36}$/.test(id))
					rmSync(accountHome(this.dir, id), { recursive: true, force: true });
				return { account_id: id, removed: true };
			};
			// Records from earlier versions in state 'disconnected' no longer hold saved credentials.
			if (a.state === 'disconnected') return forget();
			if (this.active(id))
				throw new Error('Finish or cancel sign-in before removing this account.');
			// Only this account's saved sign-in is removed. Never revoke provider-wide consent.
			await provider(a.provider).remove(this, a);
			return forget();
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
		const p = provider(a.provider);
		if (
			!['connected', 'discovered'].includes(a.state) ||
			!(p.identified ? p.identified(a) : !!a.email)
		)
			throw new Error('Account is not connected.');
		const result = await p.invocation(this, a);
		if (!('requested_scopes' in result) && p.catalog) {
			const { granted_scopes, ...rest } = result;
			return {
				...rest,
				requested_scopes: await this.catalog(a.provider)
					.then((c) => selectionScopes(p.ui, c, a.requested))
					.catch(() => null),
				granted_scopes
			};
		}
		return result;
	}
	async install(id: string) {
		if ([...this.logins.values()].some((l) => l.provider === id && ACTIVE.includes(l.state)))
			throw new Error('Finish or cancel sign-in before changing the CLI.');
		try {
			const result = await install(this.dir, id);
			// The provider's skills follow the CLI; a skills failure leaves the tool installed
			// and shows on the skills row.
			await followTool(this.dir, id).catch(() => {});
			return result;
		} finally {
			this.catalogs.delete(id);
		}
	}
	skills(id: string, action: 'install' | 'remove') {
		return action === 'install' ? installSkills(this.dir, id) : removeSkills(this.dir, id);
	}
	// A hosted sign-in finishes on the server even if the page was reloaded or closed while the
	// person was on the provider's page; the page only shows progress.
	private watch(l: Login) {
		const next = () => {
			const t = setTimeout(async () => {
				this.watchers.delete(t);
				if (!this.logins.has(l.id) || !ACTIVE.includes(l.state)) return;
				try {
					this.login(l.id, l.actor);
					if (l.callback && l.state === 'awaiting_consent') await this.poll(l.id, l.actor);
				} catch {}
				if (ACTIVE.includes(l.state)) next();
			}, 2000);
			t.unref?.();
			this.watchers.add(t);
		};
		if (ACTIVE.includes(l.state)) next();
	}
	stop() {
		for (const t of this.watchers) clearTimeout(t);
		this.watchers.clear();
		for (const l of this.logins.values()) {
			if (['starting', 'awaiting_consent'].includes(l.state)) {
				l.state = 'cancelled';
				l.child?.kill();
			}
		}
	}
}
