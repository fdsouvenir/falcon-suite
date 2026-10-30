import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { runRaw } from '../../cli.js';
import { existingId, validEmail } from '../../discover.js';
import type { Account } from '../../model.js';
import { Registry } from '../../store.js';
import { PublicError, type Host, type Login, type ProviderModule } from '../types.js';
import ui, { ONE_ACCOUNT, SCOPES } from './ui.js';

// gtm (ZoomInfo's GTM AI CLI) signs in with its own registered app, whose only return address
// is http://localhost:9876/callback on the computer running gtm. Link runs `gtm auth login`,
// shows the person the sign-in address gtm prints, and forwards the address they paste back to
// the gtm process waiting on that port. gtm does the registration, PKCE, code exchange and
// saving itself.
const PORT = 9876;
const REDIRECT = `http://localhost:${PORT}/callback`;
// gtm waits five minutes for the return (REDIRECT_SERVER_TIMEOUT_MS).
const WINDOW = 5 * 60 * 1000;
// gtm's store is fixed: ~/.config/gtm-ai/credentials (no override).
const credentials = () => path.join(homedir(), '.config', 'gtm-ai', 'credentials');
const USERNAME = /^[^\s()]{1,254}$/;
const PASTE =
	'Paste the whole address from the ZoomInfo tab. It starts with http://localhost:9876/callback';

type Prepared = {
	exited: Promise<{ ok: boolean; output: () => string }>;
	// The saved sign-in a reconnect replaces, restored if ZoomInfo signs in someone else.
	previous: Buffer | null;
};

// "Logged in as <first> <last> (<ziUsername>)", read by gtm from the access token.
async function whoami(tool: string) {
	const out = await runRaw(tool, ['auth', 'whoami'], process.env, 30000);
	const m = /^Logged in as (.*) \(([^()\s]+)\)\s*$/m.exec(out.stdout);
	if (!out.ok || !m || !USERNAME.test(m[2])) return null;
	const name = m[1]
		.split(' ')
		.filter((w) => w && w !== 'undefined' && w !== 'null')
		.join(' ')
		.replace(/[\x00-\x1f\x7f]/g, '')
		.slice(0, 80);
	return { name: name || null, username: m[2] };
}
// Link's own commands that do nothing, ahead of the real ones on the sign-in's PATH, so gtm
// can't open a browser on the Office's desktop and prints the sign-in address instead.
function noBrowser(dir: string) {
	const folder = path.join(dir, 'zoominfo', 'no-browser');
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	for (const name of ['xdg-open', 'open'])
		writeFileSync(path.join(folder, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
	return folder;
}
function restore(previous: Buffer | null) {
	const file = credentials();
	if (!previous) return rmSync(file, { force: true });
	const pending = `${file}.${process.pid}.restore`;
	writeFileSync(pending, previous, { mode: 0o600 });
	renameSync(pending, file);
}
// Known gtm failures in plain words. Raw output is never shown or saved.
function loginError(output: string) {
	if (/EADDRINUSE|address already in use/i.test(output))
		return new PublicError(
			'zoominfo_port_busy',
			'ZoomInfo sign-in needs port 9876 on this Office, and another program is using it. Close that program, then try again.'
		);
	if (/State mismatch/i.test(output))
		return new PublicError(
			'zoominfo_wrong_signin',
			'That address is from a different ZoomInfo sign-in, so nothing changed. Start again and paste the address from the new tab.'
		);
	if (/Token exchange failed/i.test(output))
		return new PublicError(
			'zoominfo_code_rejected',
			"ZoomInfo didn't accept that sign-in. It may have expired or already been used. Start again."
		);
	return new PublicError('zoominfo_signin_failed', "ZoomInfo sign-in didn't finish. Start again.");
}
function expire(host: Host, l: Login) {
	host.fail(l, 'Sign-in expired. Start again.', 'signin_expired');
	l.state = 'expired';
}

const zoominfo: ProviderModule = {
	ui,
	tool: {
		binary: 'gtm',
		// gtm 1.0.0 already has `auth whoami`, the printed sign-in address and the 9876 return
		// address Link relies on.
		minimum: '1.0.0',
		source: { kind: 'github_binary', repo: 'Zoominfo/gtm-ai-cli', assets: { x64: 'gtm-linux-x64' } }
	},
	// ZoomInfo's official agent skill (MIT), kept in the CLI's repository.
	skills: {
		repo: 'Zoominfo/gtm-ai-cli',
		branch: 'main',
		prefix: 'zoominfo-',
		path: '.claude/skills'
	},
	methods: ['paste_redirect'],
	// Sign-in uses gtm's own ZoomInfo app; nothing needs provisioning.
	readiness: () => ({ state: 'ready', message: '' }),
	async discover(tool, known) {
		// The store belongs to the account Link connected.
		if (known.some((a) => !a.external)) return [];
		const file = credentials();
		if (!existsSync(file)) return [];
		const me = await whoami(tool);
		// A sign-in gtm can't read right now stays listed; Check connection shows why.
		const prior = known.find((a) => a.external);
		if (!me) return prior ? [prior] : [];
		return [
			{
				id: existingId(['zoominfo', file]),
				provider: 'zoominfo',
				email: validEmail(me.username) ? me.username : null,
				display_name: me.name,
				owner: null,
				purpose: null,
				provider_id: me.username,
				requested: [],
				recorded_scopes: SCOPES,
				granted_scopes: null,
				state: 'discovered',
				checked_at: null,
				created_at: new Date().toISOString(),
				external: { selection: file }
			}
		];
	},
	environment: () => ({ ...process.env }),
	prepare(dir, input) {
		if (
			!input.account_id &&
			new Registry(dir).list().some((a) => a.provider === 'zoominfo' && a.state !== 'disconnected')
		)
			throw new Error(ONE_ACCOUNT);
	},
	async start(host, l, a, stage) {
		Object.assign(stage, {
			code: 'zoominfo_authorization_start',
			message: "ZoomInfo sign-in couldn't start. Try again."
		});
		const file = credentials();
		const previous = l.prior && existsSync(file) ? readFileSync(file) : null;
		const env = host.env(a);
		env.PATH = noBrowser(host.dir) + path.delimiter + (env.PATH ?? '');
		const child = spawn(host.tool(a), ['auth', 'login'], {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		l.child = child;
		let output = '';
		const exited = new Promise<{ ok: boolean; output: () => string }>((resolve) => {
			child.on('error', () => resolve({ ok: false, output: () => output }));
			child.on('close', (code) => resolve({ ok: code === 0, output: () => output }));
		});
		l.prepared = { exited, previous } satisfies Prepared;
		const address = await new Promise<string | null>((resolve) => {
			const read = (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-16384);
				const m = /https:\/\/mcp\.zoominfo\.com\/oauth\/authorize\?\S+/.exec(output);
				if (m) resolve(m[0]);
			};
			child.stdout!.on('data', read);
			child.stderr!.on('data', read);
			void exited.then(() => resolve(null));
			setTimeout(() => resolve(null), 60000).unref();
		});
		if (l.state !== 'starting') {
			child.kill();
			return;
		}
		if (!address) {
			child.kill();
			const e = loginError((await exited).output());
			if (e.code === 'zoominfo_port_busy') throw e;
			throw new Error('Sign-in address not printed.');
		}
		const url = new URL(address);
		if (
			url.hostname !== 'mcp.zoominfo.com' ||
			url.pathname !== '/oauth/authorize' ||
			url.searchParams.get('redirect_uri') !== REDIRECT ||
			url.searchParams.get('code_challenge_method') !== 'S256' ||
			!url.searchParams.get('code_challenge') ||
			!url.searchParams.get('state')
		) {
			child.kill();
			throw new Error('Provider authorization URL could not be verified.');
		}
		// gtm stops waiting after five minutes; the sign-in ends with it.
		void exited.then(() => {
			if (l.state === 'awaiting_consent') expire(host, l);
		});
		l.url = url.href;
		l.paste = { label: 'Address from the ZoomInfo tab', kind: 'url' };
		l.expires_at = new Date(Date.now() + WINDOW).toISOString();
		l.state = 'awaiting_consent';
		l.message =
			'Sign in to ZoomInfo in the new tab. Then copy the whole address from that tab and paste it here within 5 minutes.';
	},
	async finish(host, l, value) {
		if (l.state !== 'awaiting_consent' || !l.prepared)
			throw new Error('This sign-in is not waiting for a ZoomInfo address.');
		const found = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?\/callback\?[^\s"'<>]*/i.exec(
			value
		);
		let url: URL | null = null;
		try {
			if (found) url = new URL(/^https?:/i.test(found[0]) ? found[0] : `http://${found[0]}`);
		} catch {}
		if (!url || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/callback')
			throw new Error(PASTE);
		// ZoomInfo returns an error instead of a code when the person declines.
		if (url.searchParams.get('error')) {
			host.cancel(l.id, l.actor);
			return;
		}
		if (!url.searchParams.get('code')) throw new Error(PASTE);
		const { exited, previous } = l.prepared as Prepared;
		l.state = 'verifying';
		l.url = null;
		// The query string goes to the waiting gtm unchanged; it checks the state and exchanges
		// the code. gtm exits only once its server has no open connections, so this one closes.
		await new Promise<void>((resolve) => {
			const request = http.get(
				{
					host: '127.0.0.1',
					port: PORT,
					path: `/callback${url.search}`,
					agent: false,
					headers: { Connection: 'close' },
					timeout: 15000
				},
				(response) => {
					response.resume();
					response.on('end', resolve);
					response.on('error', () => resolve());
				}
			);
			request.on('timeout', () => request.destroy());
			request.on('error', () => resolve());
		});
		const result = await Promise.race([
			exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 90000).unref())
		]);
		if (!result?.ok) {
			l.child?.kill();
			const e = result
				? loginError(result.output())
				: new PublicError('zoominfo_signin_failed', "ZoomInfo sign-in didn't finish. Start again.");
			return host.fail(l, e.message, e.code);
		}
		try {
			await host.check(l.account_id, true);
			l.state = 'connected';
			l.message = 'Account connected.';
		} catch (e) {
			if (e instanceof PublicError && e.code === 'zoominfo_wrong_user') restore(previous);
			if (e instanceof PublicError) host.fail(l, e.message, e.code);
			else
				host.fail(
					l,
					"ZoomInfo sign-in finished, but the account couldn't be confirmed. Start again.",
					'zoominfo_identity_check'
				);
		}
	},
	async verify(host, a, completingLogin) {
		const me = await whoami(host.tool(a));
		if (!me) throw new Error('Identity not verified.');
		const was = a.provider_id;
		if (was && was.toLowerCase() !== me.username.toLowerCase())
			throw new PublicError(
				'zoominfo_wrong_user',
				completingLogin
					? `ZoomInfo signed in ${me.username}, not ${was}. Sign in as ${was} to reconnect this account.`
					: `The ZoomInfo sign-in on this Office now belongs to ${me.username}, not ${was}. Reconnect as ${was}.`
			);
		a.provider_id = me.username;
		a.email = validEmail(me.username) ? me.username : null;
		a.display_name = me.name;
		// The scopes gtm asks for; ZoomInfo doesn't report a grant.
		a.recorded_scopes = SCOPES;
		a.granted_scopes = null;
	},
	async remove(host, a) {
		const file = credentials();
		// Leave a sign-in that now belongs to someone else.
		const me = existsSync(file) ? await whoami(host.tool(a)) : null;
		if (me && a.provider_id && me.username.toLowerCase() !== a.provider_id.toLowerCase()) return;
		// Only the saved sign-in; gtm's registered app (client_id) stays for the next sign-in.
		rmSync(file, { force: true });
		if (existsSync(file)) throw new Error('Local credential removal could not be verified.');
	},
	async invocation(host, a) {
		return {
			account: a,
			executable: host.tool(a),
			arguments: [],
			environment: {},
			inherited_environment: [],
			requested_scopes: null,
			granted_scopes: null
		};
	},
	identified: (a) => !!a.provider_id || !!a.external,
	brief: {
		heading: 'gtm',
		note: 'For gtm accounts falcon_link_accounts returns no arguments or environment: gtm uses the one ZoomInfo sign-in saved on this Office.',
		identity: (a) =>
			a.provider_id
				? a.display_name
					? `${a.display_name} (${a.provider_id})`
					: a.provider_id
				: 'ZoomInfo account (not checked yet)',
		scopes: (a) => (a.recorded_scopes?.length ? ui.access.labels.zi_mcp : 'unknown')
	}
};
export default zoominfo;
