import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { accountHome, isolatedEnvironment, json, runRaw } from '../../cli.js';
import { existingId, validEmail } from '../../discover.js';
import { selectionScopes, type Account } from '../../model.js';
import { PublicError, type Host, type Login, type ProviderModule } from '../types.js';
import { SOURCE, STRIPE_LINK_CATALOG, splitAccess } from './catalog.js';
import ui from './ui.js';

// link-cli signs in with its own Link app (OAuth device code at login.link.com). Link runs
// `link-cli auth login`, shows the person the address and phrase it prints, and waits with
// `link-cli auth status --interval`, which saves the sign-in. The sign-in goes to a file of its
// own first and replaces the account's file only once Link has confirmed the account.
//
// The name shown in the Link app when the person approves ("Falcon Link on <computer>").
const CLIENT_NAME = 'Falcon Link';
// link-cli's own wait, in seconds; the sign-in expires with it.
const WINDOW = 15 * 60;
// Each of these takes over from the saved sign-in file in link-cli (cli.tsx); never inherited.
const SELECTION = ['LINK_ACCESS_TOKEN', 'LINK_REFRESH_TOKEN'];
const PHRASE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,63}$/;

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// link-cli's own store (conf, projectName link-cli): LINK_AUTH_FILE, otherwise
// $XDG_CONFIG_HOME/link-cli-nodejs/config.json. A file without `.json` gets `.json` added.
function defaultStore() {
	const file = process.env.LINK_AUTH_FILE;
	if (file) {
		const resolved = path.resolve(file);
		return path.extname(resolved) === '.json' ? resolved : resolved + '.json';
	}
	const config = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
	return path.join(config, 'link-cli-nodejs', 'config.json');
}
const store = (dir: string, a: Account) =>
	a.external ? a.external.selection : path.join(accountHome(dir, a.id), 'link-cli', 'auth.json');
// A sign-in in progress, kept apart from the account's own file until it is confirmed.
const signinFile = (dir: string, id: string) => path.join(dir, 'stripe-link', `signin-${id}.json`);
// Read directly: `link-cli auth status` creates the file when it is missing.
function saved(file: string) {
	try {
		if (statSync(file).size > 1048576) return false;
		const auth = JSON.parse(readFileSync(file, 'utf8'))?.auth;
		return (
			!!auth &&
			typeof auth === 'object' &&
			[auth.access_token, auth.refresh_token].some((t) => typeof t === 'string' && t)
		);
	} catch {
		return false;
	}
}
// Commands that yield results print a JSON array; others print one object.
const last = (out: unknown): any => (Array.isArray(out) ? out.at(-1) : out);
const clean = (s: string, max: number) => s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
// `link-cli user-info retrieve`: id, email and name of the Link user.
function identity(out: unknown) {
	const me = last(out);
	const id =
		typeof me?.id === 'string' && /^[\x21-\x7e]{1,128}$/.test(me.id) ? (me.id as string) : null;
	const email = validEmail(me?.email) ? (me.email as string) : null;
	if (!id && !email) return null;
	const name = typeof me?.name === 'string' && me.name.trim() ? clean(me.name.trim(), 80) : null;
	return { id: (id ?? email)!, email, name };
}
const userInfo = async (tool: string, env: NodeJS.ProcessEnv, file?: string) =>
	identity(
		await json(
			tool,
			[...(file ? ['--auth', file] : []), 'user-info', 'retrieve', '--format', 'json'],
			env,
			30000
		)
	);
// Granted access from `link-cli auth status`: the scopes (the token endpoint separates them
// with commas or spaces) and the source actions. Null when Link didn't report the grant.
function granted(status: any): string[] | null {
	if (typeof status?.scope !== 'string' && !Array.isArray(status?.authorization_details))
		return null;
	const scopes = String(status.scope ?? '')
		.split(/[\s,]+/)
		.filter((s) => /^[\x21-\x7e]{1,128}$/.test(s));
	const actions = (Array.isArray(status.authorization_details) ? status.authorization_details : [])
		.filter((d: any) => d?.type === 'source' && Array.isArray(d.actions))
		.flatMap((d: any) => d.actions)
		.filter((s: unknown) => typeof s === 'string' && /^[a-z_]{1,64}$/.test(s))
		.map((s: string) => SOURCE + s);
	return [...new Set([...scopes, ...actions])];
}
// link-cli's own sign-out of one file: revokes its refresh token at Link and deletes it.
async function discard(host: Host, a: Account, file: string) {
	if (existsSync(file)) {
		const env: NodeJS.ProcessEnv = { ...process.env, NO_UPDATE_NOTIFIER: '1' };
		for (const key of SELECTION) delete env[key];
		await runRaw(host.tool(a), ['--auth', file, 'auth', 'logout', '--format', 'json'], env, 30000);
	}
	rmSync(file, { force: true });
}
function expire(host: Host, l: Login) {
	host.fail(l, 'Sign-in expired. Start again.', 'signin_expired');
	l.state = 'expired';
}
// Known link-cli failures in plain words. Raw output is never shown or saved.
function waited(host: Host, l: Login, ok: boolean, output: string) {
	let result: any = null;
	try {
		result = last(JSON.parse(output));
	} catch {}
	if (ok && result?.authenticated === true) return true;
	if (ok) expire(host, l);
	else if (/denied/i.test(result?.message ?? '')) host.cancel(l.id, l.actor);
	else if (/expired/i.test(result?.message ?? '')) expire(host, l);
	else if (/not eligible/i.test(result?.message ?? ''))
		host.fail(
			l,
			"Link declined the sign-in: this Link account isn't eligible for the access you chose.",
			'stripe_link_not_eligible'
		);
	else host.fail(l, "Stripe Link sign-in didn't finish. Start again.", 'stripe_link_signin_failed');
	return false;
}
async function complete(host: Host, l: Login, a: Account, pending: string) {
	l.state = 'verifying';
	l.url = null;
	l.code = null;
	try {
		const me = await userInfo(host.tool(a), host.env(a), pending);
		if (!me)
			throw new PublicError(
				'stripe_link_identity_failed',
				"Stripe Link signed in, but Link couldn't confirm the account. Start again."
			);
		const prior = l.prior;
		if (
			prior &&
			(prior.provider_id
				? prior.provider_id !== me.id
				: !!prior.email && prior.email.toLowerCase() !== me.email?.toLowerCase())
		)
			throw new PublicError(
				'stripe_link_wrong_account',
				`Stripe Link signed in a different account. Sign in as ${prior.email ?? 'the account connected here before'} to reconnect it, or add the other account separately.`
			);
		// The confirmed sign-in replaces the account's file; the one it replaces is signed out.
		const file = store(host.dir, a);
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const replaced = existsSync(file)
			? path.join(path.dirname(pending), `replaced-${randomUUID()}.json`)
			: null;
		if (replaced) renameSync(file, replaced);
		renameSync(pending, file);
		if (replaced) await discard(host, a, replaced);
		await host.check(a.id, true);
		l.state = 'connected';
		l.message = 'Account connected.';
	} catch (e) {
		if (e instanceof PublicError) host.fail(l, e.message, e.code);
		else
			host.fail(
				l,
				"Stripe Link sign-in finished, but the account couldn't be confirmed. Start again.",
				'stripe_link_identity_check'
			);
	}
}

const stripeLink: ProviderModule = {
	ui,
	tool: {
		binary: 'link-cli',
		// link-cli CHANGELOG 1.1.0: "Request financial-insights source actions … by default during
		// `auth login`, with independent opt-outs". Link passes --no-financial-insights when no
		// financial data is chosen.
		minimum: '1.1.0',
		source: {
			kind: 'github_binary',
			repo: 'stripe/link-cli',
			assets: { x64: 'link-cli-linux-x64', arm64: 'link-cli-linux-arm64' },
			tag_prefix: '@stripe/link-cli@'
		}
	},
	// Stripe's official Link CLI skills (MIT), kept in the CLI's repository.
	skills: { repo: 'stripe/link-cli', branch: 'main', prefix: 'stripe-link-', path: 'skills' },
	methods: ['device_code'],
	// Sign-in uses link-cli's own Link app; nothing needs provisioning.
	readiness: () => ({ state: 'ready', message: '' }),
	catalog: async () => STRIPE_LINK_CATALOG,
	async discover() {
		const file = defaultStore();
		if (!saved(file)) return [];
		return [
			{
				id: existingId(['stripe-link', file]),
				provider: 'stripe-link',
				email: null,
				owner: null,
				purpose: null,
				provider_id: null,
				requested: [],
				recorded_scopes: null,
				granted_scopes: null,
				state: 'discovered',
				checked_at: null,
				created_at: new Date().toISOString(),
				external: { selection: file }
			}
		];
	},
	environment(dir, a) {
		const env = a.external ? { ...process.env } : isolatedEnvironment(dir, a.id);
		for (const key of SELECTION) delete env[key];
		env.LINK_AUTH_FILE = store(dir, a);
		// Link reads no update notice from link-cli's output.
		env.NO_UPDATE_NOTIFIER = '1';
		return env;
	},
	async start(host, l, a, stage) {
		Object.assign(stage, {
			code: 'stripe_link_authorization_start',
			message: "Stripe Link sign-in couldn't start. Try again."
		});
		const access = splitAccess(selectionScopes(ui, STRIPE_LINK_CATALOG, a.requested));
		const pending = signinFile(host.dir, l.id);
		mkdirSync(path.dirname(pending), { recursive: true, mode: 0o700 });
		rmSync(pending, { force: true });
		const tool = host.tool(a);
		const env = host.env(a);
		const out = last(
			await json(
				tool,
				[
					'--auth',
					pending,
					'auth',
					'login',
					'--client-name',
					CLIENT_NAME,
					'--scope',
					access.scopes.join(' '),
					// Without explicit source actions link-cli asks for all four.
					...(access.source_actions.length
						? access.source_actions.flatMap((s) => ['--source-actions', s])
						: ['--no-financial-insights']),
					'--format',
					'json'
				],
				env,
				30000
			)
		);
		let url: URL | null = null;
		try {
			url = new URL(out?.verification_url);
		} catch {}
		if (
			!url ||
			url.protocol !== 'https:' ||
			!(url.hostname === 'link.com' || url.hostname.endsWith('.link.com')) ||
			typeof out.phrase !== 'string' ||
			!PHRASE.test(out.phrase)
		) {
			rmSync(pending, { force: true });
			throw new Error('Provider sign-in address could not be verified.');
		}
		if (l.state !== 'starting') return void rmSync(pending, { force: true });
		const child = spawn(
			tool,
			[
				'--auth',
				pending,
				'auth',
				'status',
				'--interval',
				'5',
				'--timeout',
				String(WINDOW),
				'--format',
				'json'
			],
			{ env, stdio: ['ignore', 'pipe', 'ignore'] }
		);
		l.child = child;
		let output = '';
		child.stdout!.on('data', (chunk) => {
			output += chunk.toString();
			if (output.length > 262144) child.kill();
		});
		let settled = false;
		const settle = async (ok: boolean) => {
			if (settled) return;
			settled = true;
			try {
				if (l.state === 'awaiting_consent' && waited(host, l, ok, output))
					await complete(host, l, a, pending);
			} finally {
				// A sign-in that didn't become the account's is signed out and deleted.
				await discard(host, a, pending).catch(() => {});
			}
		};
		child.on('error', () => void settle(false));
		child.on('close', (code) => void settle(code === 0));
		l.url = url.href;
		l.code = out.phrase;
		l.expires_at = new Date(Date.now() + WINDOW * 1000).toISOString();
		l.state = 'awaiting_consent';
		l.message =
			'Open Stripe Link, sign in to your Link account and use the phrase below to approve the connection.';
	},
	async verify(host, a) {
		const tool = host.tool(a);
		const env = host.env(a);
		const me = await userInfo(tool, env);
		if (!me) throw new Error('Identity not verified.');
		if (a.provider_id && a.provider_id !== me.id)
			throw new PublicError(
				'stripe_link_wrong_account',
				`This connection now belongs to a different Link account. Reconnect as ${a.email ?? 'the account connected before'}.`
			);
		const status = last(await json(tool, ['auth', 'status', '--format', 'json'], env, 30000));
		if (status?.authenticated !== true) throw new Error('Identity not verified.');
		a.provider_id = me.id;
		a.email = me.email;
		a.display_name = me.name;
		a.granted_scopes = granted(status);
		const held = new Set(a.granted_scopes ?? []);
		a.grant = a.granted_scopes
			? {
					status: 'known',
					selected_not_granted: a.requested.filter((id) =>
						STRIPE_LINK_CATALOG.rows.some((r) =>
							r.levels.some((l) => l.id === id && l.scopes.some((s) => !held.has(s)))
						)
					)
				}
			: { status: 'unknown', selected_not_granted: null };
		a.recorded_scopes = null;
	},
	async remove(host, a) {
		// Only this account's file: link-cli's own sign-out revokes it at Link and deletes it.
		const file = store(host.dir, a);
		await discard(host, a, file);
		if (existsSync(file)) throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		const file = store(host.dir, a);
		const executable = host.tool(a);
		const requested = a.requested.length
			? splitAccess(selectionScopes(ui, STRIPE_LINK_CATALOG, a.requested))
			: null;
		const granted = a.granted_scopes ? splitAccess(a.granted_scopes) : null;
		return {
			account: a,
			executable,
			arguments: [],
			environment: { LINK_AUTH_FILE: file },
			unset_environment: SELECTION,
			inherited_environment: [],
			command_prefix: `env ${SELECTION.map((k) => `-u ${k} `).join('')}LINK_AUTH_FILE=${quote(file)} ${quote(executable)}`,
			requested_scopes: requested?.scopes ?? null,
			granted_scopes: granted?.scopes ?? null,
			requested_source_actions: requested?.source_actions ?? null,
			granted_source_actions: granted?.source_actions ?? null
		};
	},
	identified: (a) => !!a.provider_id || !!a.external,
	brief: {
		heading: 'link-cli',
		note: 'For link-cli accounts falcon_link_accounts also returns a command_prefix that selects the account, and the source actions (financial data) separately from the scopes.',
		identity: (a) =>
			a.email
				? a.display_name
					? `${a.display_name} (${a.email})`
					: a.email
				: 'Stripe Link account (not checked yet)',
		scopes(a) {
			const values = a.granted_scopes?.filter((s) => !ui.baseline.includes(s));
			return values?.length
				? values.map((s) => ui.access.labels[s] ?? s).join('; ')
				: a.granted_scopes
					? 'none'
					: 'unknown';
		}
	}
};
export default stripeLink;
