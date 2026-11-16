import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { accountHome, isolatedEnvironment, runRaw } from '../../cli.js';
import type { Account } from '../../model.js';
import { PublicError, type Host, type Login, type ProviderModule } from '../types.js';
import ui, { number } from './ui.js';

// wacli (openclaw/wacli) links this Office to a WhatsApp account as a linked device. Link runs
// `wacli auth` into a store of its own and shows the QR code (or the pairing code, when the
// person gives a phone number) that wacli reports; wacli changes the QR code while it waits.
// Once WhatsApp confirms the link and wacli has finished its first sync, the store becomes the
// account's. Link then keeps `wacli sync --follow` running for the account (`follow`).
//
// The account's store (session.db, wacli.db).
const store = (dir: string, a: Account) => path.join(accountHome(dir, a.id), 'wacli');
// A sign-in in progress, kept apart from the account's own store until it is confirmed.
const signinStore = (dir: string, id: string) => path.join(dir, 'wacli', `signin-${id}`);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// whatsmeow's QR payload and pairing code: printable ASCII without spaces.
const QR = /^[\x21-\x7e]{1,2048}$/;
const PAIR_CODE = /^[A-Za-z0-9-]{4,16}$/;
const JID = /^[0-9A-Za-z._:-]{1,64}@[a-z.]{1,64}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,24}$/;

type Prepared = { phone: string | null };
type Linked = { jid: string };

// `wacli --read-only --json auth status`: {success, data:{authenticated, linked_jid, phone}}.
// Read-only, it reads session.db without taking the store's lock or connecting.
async function linked(tool: string, env: NodeJS.ProcessEnv, dir: string): Promise<Linked | null> {
	if (!existsSync(path.join(dir, 'session.db'))) return null;
	const out = await runRaw(
		tool,
		['--store', dir, '--read-only', '--json', 'auth', 'status'],
		env,
		30000
	);
	let status: any = null;
	try {
		status = JSON.parse(out.stdout);
	} catch {}
	const data = status?.success === true ? status.data : null;
	if (data?.authenticated !== true || typeof data.linked_jid !== 'string') return null;
	return JID.test(data.linked_jid) ? { jid: data.linked_jid } : null;
}
// Environment for runs against a store given with --store, outside any account's home.
function plain() {
	const env = { ...process.env };
	delete env.WACLI_READONLY;
	delete env.WACLI_STORE_DIR;
	return env;
}
// wacli's own sign-out (removes this Office from the phone's linked devices), then the store.
async function discard(host: Host, a: Account, dir: string) {
	if (!existsSync(dir)) return;
	const env = plain();
	if (await linked(host.tool(a), env, dir).catch(() => null))
		await runRaw(host.tool(a), ['--store', dir, '--json', 'auth', 'logout'], env, 60000);
	rmSync(dir, { recursive: true, force: true });
}
// Known wacli failures in plain words (internal/wa/client.go qrChannelEventError). Raw output
// is never shown or saved.
function failure(host: Host, l: Login, error: string) {
	if (/passkey/i.test(error))
		return host.fail(
			l,
			'WhatsApp asked to confirm the link with a passkey, which wacli can’t do yet. Nothing changed.',
			'wacli_passkey'
		);
	if (/multi-?device/i.test(error))
		return host.fail(
			l,
			'The code was scanned, but this WhatsApp account can’t use linked devices. Nothing changed.',
			'wacli_no_multidevice'
		);
	if (/outdated/i.test(error))
		return host.fail(
			l,
			'WhatsApp no longer accepts this version of wacli. Update wacli, then try again.',
			'wacli_outdated'
		);
	if (/timed out/i.test(error) || !error) {
		host.fail(l, 'Sign-in expired. Start again.', 'signin_expired');
		l.state = 'expired';
		return;
	}
	if (/phone/i.test(error))
		return host.fail(
			l,
			'WhatsApp didn’t accept that phone number. Check the number and its country code, then try again.',
			'wacli_phone_rejected'
		);
	host.fail(l, 'WhatsApp linking didn’t finish. Start again.', 'wacli_signin_failed');
}
async function complete(host: Host, l: Login, a: Account, pending: string, me: Linked) {
	const prior = l.prior;
	if (prior?.provider_id && prior.provider_id !== me.jid)
		throw new PublicError(
			'wacli_wrong_account',
			`WhatsApp linked ${number({ ...a, provider_id: me.jid })}, not ${number(prior)}. Link ${number(prior)} to reconnect this account, or add the other number separately.`
		);
	// The confirmed store replaces the account's; the one it replaces is signed out.
	await host.pause(a.id);
	const file = store(host.dir, a);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const replaced = existsSync(file)
		? path.join(path.dirname(pending), `replaced-${randomUUID()}`)
		: null;
	if (replaced) renameSync(file, replaced);
	renameSync(pending, file);
	if (replaced) await discard(host, a, replaced).catch(() => {});
	await host.check(a.id, true);
	l.state = 'connected';
	l.message = 'Account connected.';
}

const wacli: ProviderModule = {
	ui,
	tool: {
		binary: 'wacli',
		// wacli 0.26.1 is the release Link was built against: `auth --events` QR and pairing-code
		// events, `--read-only` auth status and the JSON envelope.
		minimum: '0.26.1',
		source: {
			kind: 'github',
			repo: 'openclaw/wacli',
			archive: 'wacli',
			checksums: 'checksums.txt'
		},
		// `wacli version` prints the bare version.
		version_args: ['version']
	},
	methods: ['qr_code'],
	// wacli needs no app keys; nothing needs provisioning.
	readiness: () => ({ state: 'ready', message: '' }),
	discover: async () => [],
	environment(dir, a) {
		const env = isolatedEnvironment(dir, a.id);
		// Link's own runs sign in, sync and sign out; agents get read-only mode (invocation).
		delete env.WACLI_READONLY;
		env.WACLI_STORE_DIR = store(dir, a);
		return env;
	},
	validate(input) {
		if (input.phone && !PHONE.test(input.phone.trim()))
			throw new Error('Enter the phone number with its country code, for example +44 7700 900123.');
	},
	prepare: (_dir, input): Prepared => ({
		phone: input.phone?.trim() ? input.phone.replace(/[^0-9]/g, '') : null
	}),
	async start(host, l, a, stage) {
		Object.assign(stage, {
			code: 'wacli_signin_start',
			message: "WhatsApp linking couldn't start. Try again."
		});
		const { phone } = (l.prepared ?? { phone: null }) as Prepared;
		const pending = signinStore(host.dir, l.id);
		mkdirSync(path.dirname(pending), { recursive: true, mode: 0o700 });
		rmSync(pending, { recursive: true, force: true });
		const tool = host.tool(a);
		const env = host.env(a);
		const child = spawn(
			tool,
			['--store', pending, '--events', '--json', 'auth', ...(phone ? ['--phone', phone] : [])],
			{ env, stdio: ['ignore', 'ignore', 'pipe'] }
		);
		l.child = child;
		// The last error wacli reported, kept in memory only to choose a plain message.
		let error = '';
		let buffer = '';
		let shown: () => void = () => {};
		const first = new Promise<boolean>((resolve) => {
			shown = () => resolve(true);
			child.on('error', () => resolve(false));
			child.on('close', () => resolve(false));
			setTimeout(() => resolve(false), 90000).unref();
		});
		// wacli's NDJSON lifecycle events on stderr: qr_code {code}, pair_code {phone, code},
		// error {message}. Anything else is ignored.
		child.stderr!.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			if (buffer.length > 65536) buffer = buffer.slice(-65536);
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				let e: any;
				try {
					e = JSON.parse(line);
				} catch {
					continue;
				}
				if (!['starting', 'awaiting_consent'].includes(l.state)) continue;
				const code = e?.data?.code;
				if (e?.event === 'qr_code' && !phone && typeof code === 'string' && QR.test(code)) {
					l.qr = code;
					shown();
				} else if (
					e?.event === 'pair_code' &&
					phone &&
					typeof code === 'string' &&
					PAIR_CODE.test(code)
				) {
					l.code = code;
					shown();
				} else if (e?.event === 'error' && typeof e.data?.message === 'string')
					error = e.data.message.slice(0, 512);
			}
		});
		// wacli doesn't report the moment WhatsApp confirms the link, so Link reads the store.
		const watch = setInterval(async () => {
			if (l.state !== 'awaiting_consent') return clearInterval(watch);
			if (await linked(tool, env, pending).catch(() => null)) {
				if (l.state !== 'awaiting_consent') return;
				clearInterval(watch);
				l.state = 'verifying';
				l.qr = null;
				l.code = null;
				l.message =
					'Linked. wacli is saving the messages WhatsApp sends to this Office; the account is ready when it finishes.';
			}
		}, 2000);
		watch.unref();
		let settled = false;
		const settle = async () => {
			if (settled) return;
			settled = true;
			clearInterval(watch);
			try {
				if (!['awaiting_consent', 'verifying'].includes(l.state)) return;
				// A store WhatsApp linked becomes the account's, even if wacli stopped during its
				// first sync.
				const me = await linked(tool, env, pending).catch(() => null);
				if (!me) return failure(host, l, error);
				l.state = 'verifying';
				l.qr = null;
				l.code = null;
				await complete(host, l, a, pending, me);
			} catch (e) {
				if (e instanceof PublicError) host.fail(l, e.message, e.code);
				else
					host.fail(
						l,
						"WhatsApp linked, but the account couldn't be confirmed. Start again.",
						'wacli_identity_check'
					);
			} finally {
				// A store that didn't become the account's is signed out and deleted.
				await discard(host, a, pending).catch(() => {});
			}
		};
		child.on('error', () => void settle());
		child.on('close', () => void settle());
		const ok = await first;
		if (l.state !== 'starting') return;
		if (!ok) {
			child.kill();
			// wacli stopped before showing a code, for example because WhatsApp refused the number.
			if (error) return failure(host, l, error);
			throw new Error('No QR code or pairing code was reported.');
		}
		l.state = 'awaiting_consent';
		l.message = phone
			? 'On your phone, open WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, and enter this code.'
			: 'On your phone, open WhatsApp → Settings → Linked devices → Link a device, and scan this code. It changes every 20 seconds; this page shows the current one.';
	},
	async verify(host, a) {
		const me = await linked(host.tool(a), host.env(a), store(host.dir, a));
		if (!me)
			throw new PublicError(
				'wacli_not_linked',
				'This Office is no longer a linked device of this WhatsApp account. Link it again.'
			);
		if (a.provider_id && a.provider_id !== me.jid)
			throw new PublicError(
				'wacli_wrong_account',
				`This store now belongs to ${number({ ...a, provider_id: me.jid })}, not ${number(a)}. Link ${number(a)} again.`
			);
		a.provider_id = me.jid;
		a.email = null;
		a.recorded_scopes = null;
		a.granted_scopes = null;
	},
	async remove(host, a) {
		// Only this account's store; Link has stopped its sync, which holds the store's lock.
		const file = store(host.dir, a);
		await discard(host, a, file);
		if (existsSync(file)) throw new Error('Local credential removal could not be verified.');
	},
	follow: (host, a) => ({
		args: ['--store', store(host.dir, a), 'sync', '--follow'],
		env: host.env(a)
	}),
	async invocation(host, a) {
		const file = store(host.dir, a);
		const executable = host.tool(a);
		return {
			account: a,
			executable,
			arguments: [],
			environment: { WACLI_STORE_DIR: file, WACLI_READONLY: '1' },
			inherited_environment: [],
			command_prefix: `env WACLI_STORE_DIR=${quote(file)} WACLI_READONLY=1 ${quote(executable)}`,
			requested_scopes: null,
			granted_scopes: null
		};
	},
	identified: (a) => !!a.provider_id,
	brief: {
		heading: 'wacli',
		note: 'For wacli accounts falcon_link_accounts returns a command_prefix that selects the account’s store (WACLI_STORE_DIR) with WACLI_READONLY=1, under which wacli rejects commands that send or change anything. Link keeps `wacli sync --follow` running for each connected account; it holds the store’s lock, and wacli’s reading commands (messages, chats, contacts, auth status) run alongside it without the lock.',
		identity: number,
		scopes: () => 'read-only'
	}
};
export default wacli;
