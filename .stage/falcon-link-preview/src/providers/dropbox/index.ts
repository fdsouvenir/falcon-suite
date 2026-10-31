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
import { homedir } from 'node:os';
import path from 'node:path';
import { CallbackHandoff, callbackConfig, callbackURI } from '../../callback.js';
import { accountHome, isolatedEnvironment, json, provision } from '../../cli.js';
import { existingId, validEmail } from '../../discover.js';
import { selectionScopes, type Account } from '../../model.js';
import { PublicError, type Host, type Login, type ProviderModule } from '../types.js';
import { DROPBOX_CATALOG, TEAM, splitScopes } from './catalog.js';
import ui, { describeDropbox } from './ui.js';

// Link signs in itself instead of running `dbxcli login`, which asks Dropbox for every scope the
// app allows (it sends no scope parameter). It then writes the credential where dbxcli reads it.
const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const APP_KEY = /^[a-z0-9]{8,32}$/;
// dbxcli auth file (cmd/auth.go): {"<domain>": {"<token type>": credential}}. The domain is ''
// for Dropbox itself. dbxcli uses `personal` for ordinary commands, `teamManage` for
// `dbxcli team …` and `teamAccess` for `--as-member`, and refreshes each with its saved app_key.
const DOMAIN = '';
// Overrides every saved credential in dbxcli; never inherited from the host.
const SELECTION = ['DBXCLI_ACCESS_TOKEN'];
const SETUP = "Dropbox sign-in isn't set up on this Office. Contact your administrator.";

type Token = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string[];
	account_id?: string;
	team_id?: string;
};
// A sign-in is one Dropbox consent for the person, then one for team administration if chosen.
type Plan = {
	personal: string[];
	team: string[];
	stage: 'personal' | 'team';
	personalToken?: Token;
	teamId?: string;
};

// Single-quoted for a POSIX shell command line.
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const appKey = (dir: string) => {
	const key = provision(dir).dropbox_app_key;
	if (!key || !APP_KEY.test(key)) throw new PublicError('dropbox_setup', SETUP);
	return key;
};
// dbxcli's own store: DBXCLI_AUTH_FILE, otherwise ~/.config/dbxcli/auth.json.
function defaultStore() {
	const file = process.env.DBXCLI_AUTH_FILE;
	if (!file) return path.join(homedir(), '.config', 'dbxcli', 'auth.json');
	return file.startsWith('~') ? path.join(homedir(), file.slice(1)) : path.resolve(file);
}
const authFile = (dir: string, a: Account) =>
	a.external
		? a.external.selection
		: path.join(accountHome(dir, a.id), '.config', 'dbxcli', 'auth.json');
const unreadable = () => new Error('The saved Dropbox sign-in could not be read.');
function readStore(file: string): Record<string, Record<string, unknown>> {
	let text: string;
	try {
		if (statSync(file).size > 1048576) throw unreadable();
		text = readFileSync(file, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw unreadable();
	}
	try {
		const map = JSON.parse(text);
		if (map && typeof map === 'object' && !Array.isArray(map)) return map;
	} catch {}
	throw unreadable();
}
// dbxcli also reads a bare access-token string from earlier versions.
const saved = (c: any) =>
	typeof c === 'string'
		? !!c
		: !!c && typeof c === 'object' && !!(c.access_token || c.refresh_token);
// Replaces this account's credentials and keeps everything else in the file.
function writeStore(file: string, slots: Record<string, unknown>) {
	const map = readStore(file);
	const domain: Record<string, unknown> = { ...map[DOMAIN] };
	for (const [slot, value] of Object.entries(slots))
		if (value === undefined) delete domain[slot];
		else domain[slot] = value;
	map[DOMAIN] = domain;
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const pending = `${file}.${randomUUID()}`;
	try {
		writeFileSync(pending, JSON.stringify(map), { mode: 0o600 });
		renameSync(pending, file);
	} finally {
		rmSync(pending, { force: true });
	}
}
// The credential shape dbxcli saves after its own login.
const credential = (t: Token, key: string) => ({
	access_token: t.access_token,
	refresh_token: t.refresh_token,
	token_type: 'Bearer',
	expiry: new Date(Date.now() + t.expires_in * 1000).toISOString(),
	app_key: key
});
const failed = () =>
	new PublicError('dropbox_exchange_failed', "Dropbox couldn't finish sign-in. Start again.");
async function exchange(key: string, code: string, verifier: string, redirect?: string) {
	const body = new URLSearchParams({
		code,
		grant_type: 'authorization_code',
		client_id: key,
		code_verifier: verifier
	});
	if (redirect) body.set('redirect_uri', redirect);
	let response: Response;
	let t: any;
	try {
		response = await fetch(TOKEN, {
			method: 'POST',
			body,
			redirect: 'error',
			signal: AbortSignal.timeout(20000)
		});
		t = await response.json();
	} catch {
		throw failed();
	}
	if (t?.error === 'invalid_grant')
		throw new PublicError(
			'dropbox_code_expired',
			'That sign-in code has expired or was already used. Start again.'
		);
	if (
		!response.ok ||
		typeof t?.access_token !== 'string' ||
		typeof t.refresh_token !== 'string' ||
		typeof t.expires_in !== 'number'
	)
		throw failed();
	return {
		access_token: t.access_token,
		refresh_token: t.refresh_token,
		expires_in: t.expires_in,
		scope: typeof t.scope === 'string' ? t.scope.split(' ').filter(Boolean) : [],
		...(typeof t.account_id === 'string' ? { account_id: t.account_id } : {}),
		...(typeof t.team_id === 'string' ? { team_id: t.team_id } : {})
	} satisfies Token;
}
// Dropbox's token response lists the scopes it granted. Dropbox may add scopes another one
// depends on; it must not leave out any that were chosen.
function covers(t: Token, wanted: string[]) {
	if (wanted.some((s) => !t.scope.includes(s)))
		throw new PublicError(
			'dropbox_permission_mismatch',
			"Dropbox didn't grant all the access you chose, so nothing changed. Try again, or contact your administrator if it keeps happening."
		);
}
// The person's team, to match against the team that approves team administration.
async function teamOf(t: Token) {
	try {
		const response = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
			method: 'POST',
			headers: { Authorization: `Bearer ${t.access_token}` },
			redirect: 'error',
			signal: AbortSignal.timeout(15000)
		});
		const me = (await response.json()) as any;
		if (response.ok && me?.account_id === t.account_id)
			return typeof me.team?.id === 'string' ? (me.team.id as string) : null;
	} catch {}
	throw new PublicError(
		'dropbox_identity_failed',
		"Dropbox signed in, but Link couldn't confirm the account. Start again."
	);
}
async function begin(host: Host, l: Login, plan: Plan) {
	const callback = callbackConfig(host.dir);
	const state = randomBytes(32).toString('base64url');
	l.verifier = randomBytes(48).toString('base64url');
	const url = new URL(AUTHORIZE);
	url.search = new URLSearchParams({
		client_id: appKey(host.dir),
		response_type: 'code',
		token_access_type: 'offline',
		scope: (plan.stage === 'personal' ? plan.personal : plan.team).join(' '),
		state,
		code_challenge: createHash('sha256').update(l.verifier).digest('base64url'),
		code_challenge_method: 'S256',
		...(callback ? { redirect_uri: callbackURI(callback, 'dropbox') } : {})
	}).toString();
	const before = l.state;
	if (callback) {
		l.callback = await CallbackHandoff.create(callback, 'dropbox', state);
		if (l.state !== before) {
			await l.callback.cancel();
			return;
		}
		l.hosted = true;
	} else l.paste = { label: 'Code shown by Dropbox', kind: 'text' };
	l.expires_at = new Date(Date.now() + (callback ? 10 : 15) * 60000).toISOString();
	const two = plan.team.length > 0;
	l.step = two ? { number: plan.stage === 'personal' ? 1 : 2, total: 2 } : undefined;
	const then = callback
		? 'then return here. Your account will connect automatically.'
		: 'Dropbox then shows a code: copy it and paste it here.';
	l.message =
		plan.stage === 'team'
			? `Next, a team admin approves team administration. Open Dropbox sign-in, sign in as a team admin and allow access; ${then}`
			: two
				? `First, sign in with the Dropbox account you're connecting and allow access; ${callback ? 'then return here.' : then}`
				: `Sign in with Dropbox and allow access; ${then}`;
	l.url = url.href;
	l.state = 'awaiting_consent';
}
async function step(host: Host, l: Login, code: string, redirect?: string) {
	const plan = l.prepared as Plan;
	const key = appKey(host.dir);
	l.state = 'verifying';
	l.url = null;
	const t = await exchange(key, code, l.verifier!, redirect);
	if (plan.stage === 'team') {
		if (!t.team_id || t.team_id !== plan.teamId)
			throw new PublicError(
				'dropbox_wrong_team',
				"That approval was for a different Dropbox team. An admin of this account's team needs to approve."
			);
		covers(t, plan.team);
		return save(host, l, plan.personalToken!, t);
	}
	if (!t.account_id || t.team_id)
		throw new PublicError(
			'dropbox_identity_failed',
			"Dropbox signed in, but Link couldn't confirm the account. Start again."
		);
	covers(t, plan.personal);
	const prior = l.prior?.provider_id;
	if (prior && prior !== t.account_id)
		throw new PublicError(
			'dropbox_wrong_account',
			`Dropbox signed in a different account. Sign in as ${l.prior?.email ?? 'the account connected here before'} to reconnect it, or add the other account separately.`
		);
	if (!plan.team.length) return save(host, l, t, null);
	const team = await teamOf(t);
	if (!team)
		throw new PublicError(
			'dropbox_no_team',
			"This Dropbox account isn't part of a Dropbox team, so team administration can't be added. Turn off team administration and try again."
		);
	Object.assign(plan, { personalToken: t, teamId: team, stage: 'team' });
	await begin(host, l, plan);
}
// Nothing is written until every sign-in in the plan has finished.
async function save(host: Host, l: Login, personal: Token, team: Token | null) {
	const key = appKey(host.dir);
	const a = host.registry.get(l.account_id);
	a.provider_id = personal.account_id!;
	a.granted_scopes = [...personal.scope, ...(team?.scope ?? []).map((s) => TEAM + s)];
	a.grant = { status: 'known', selected_not_granted: null };
	a.recorded_scopes = null;
	host.registry.save(a);
	const admin = team ? credential(team, key) : undefined;
	writeStore(authFile(host.dir, a), {
		personal: credential(personal, key),
		teamManage: admin,
		teamAccess: team?.scope.includes('team_data.member') ? admin : undefined
	});
	await host.check(a.id, true);
	l.state = 'connected';
	l.url = null;
	l.message = 'Account connected.';
}
const result = (out: any) => (out?.ok === true ? out.results?.[0]?.result : null);

const dropbox: ProviderModule = {
	ui,
	tool: {
		binary: 'dbxcli',
		// dbxcli CHANGELOG v3.5.0: "Structured `--output=json` support across core file, share,
		// account, team, usage, and version commands." Link reads `account` and `team info`.
		minimum: '3.5.0',
		source: { kind: 'github', repo: 'dropbox/dbxcli', archive: 'dbxcli', checksums: 'SHA256SUMS' },
		// dbxcli has no --version flag; `dbxcli version` prints "dbxcli version: 3.7.4" first.
		version_args: ['version'],
		version_prefix: 'dbxcli version: '
	},
	methods: ['hosted_callback', 'paste_code'],
	readiness(dir) {
		const ready = APP_KEY.test(provision(dir).dropbox_app_key ?? '');
		return { state: ready ? 'ready' : 'setup_required', message: ready ? '' : SETUP };
	},
	catalog: async () => DROPBOX_CATALOG,
	async discover() {
		const file = defaultStore();
		const domain = readStore(file)[DOMAIN] as Record<string, unknown> | undefined;
		if (!domain || typeof domain !== 'object' || !saved(domain.personal)) return [];
		return [
			{
				id: existingId(['dropbox', file]),
				provider: 'dropbox',
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
		env.DBXCLI_AUTH_FILE = authFile(dir, a);
		return env;
	},
	async start(host, l, a, stage) {
		Object.assign(stage, {
			code: 'dropbox_authorization_start',
			message: "Dropbox sign-in couldn't start. Try again."
		});
		const { personal, team } = splitScopes(selectionScopes(ui, DROPBOX_CATALOG, a.requested));
		const plan: Plan = { personal, team, stage: 'personal' };
		l.prepared = plan;
		await begin(host, l, plan);
	},
	async finish(host, l, value) {
		if (l.state !== 'awaiting_consent' || !l.prepared)
			throw new Error('This sign-in is not waiting for a Dropbox code.');
		if (l.hosted) throw new Error('This sign-in completes automatically.');
		const code = value.trim();
		if (!/^[A-Za-z0-9_.~-]{8,1024}$/.test(code))
			throw new Error('Paste the code Dropbox showed after you allowed access.');
		try {
			await step(host, l, code);
		} catch (e) {
			if (e instanceof PublicError) host.fail(l, e.message, e.code);
			else host.fail(l, "Dropbox sign-in didn't finish. Start again.", 'dropbox_signin_failed');
		}
	},
	async complete(host, l, code) {
		await step(host, l, code, callbackURI(l.callback!.config, 'dropbox'));
	},
	async verify(host, a) {
		const tool = host.tool(a);
		const env = host.env(a);
		const me = result(await json(tool, ['account', '--output=json'], env));
		if (typeof me?.account_id !== 'string' || !validEmail(me.email))
			throw new Error('Identity not verified.');
		if (a.provider_id && a.provider_id !== me.account_id)
			throw new PublicError(
				'dropbox_wrong_account',
				`This connection now belongs to a different Dropbox account. Reconnect as ${a.email ?? 'the account connected before'}.`
			);
		a.provider_id = me.account_id;
		a.email = me.email;
		// Team administration lives in the same file; it must still be this account's team.
		if (a.granted_scopes?.some((s) => s.startsWith(TEAM))) {
			const team = result(await json(tool, ['team', 'info', '--output=json'], env));
			if (typeof team?.team_id !== 'string' || team.team_id !== me.team?.id)
				throw new Error('Team not verified.');
		}
	},
	async remove(host, a) {
		// The account's own dbxcli file. Link doesn't revoke the sign-in at Dropbox.
		const file = authFile(host.dir, a);
		rmSync(file, { force: true });
		if (existsSync(file)) throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		const file = authFile(host.dir, a);
		const executable = host.tool(a);
		const requested = a.requested.length
			? splitScopes(selectionScopes(ui, DROPBOX_CATALOG, a.requested))
			: null;
		const granted = a.granted_scopes ? splitScopes(a.granted_scopes) : null;
		return {
			account: a,
			executable,
			arguments: [],
			environment: { DBXCLI_AUTH_FILE: file },
			unset_environment: SELECTION,
			inherited_environment: [],
			command_prefix: `env -u DBXCLI_ACCESS_TOKEN DBXCLI_AUTH_FILE=${quote(file)} ${quote(executable)}`,
			requested_scopes: requested?.personal ?? null,
			granted_scopes: granted?.personal ?? null,
			...(requested?.team.length || granted?.team.length
				? {
						team_requested_scopes: requested?.team ?? null,
						team_granted_scopes: granted?.team ?? null
					}
				: {})
		};
	},
	identified: (a) => !!a.provider_id || !!a.external,
	brief: {
		heading: 'dbxcli',
		note: 'For dbxcli accounts falcon_link_accounts also returns a command_prefix that selects the account. Team administration, where granted, is in the same file for dbxcli team commands and --as-member.',
		identity: (a) => a.email ?? 'Dropbox account (not checked yet)',
		scopes(a) {
			const values = a.granted_scopes?.filter((s) => !ui.baseline.includes(s));
			return values?.length ? describeDropbox(values).join('; ') : 'unknown';
		}
	}
};
export default dropbox;
