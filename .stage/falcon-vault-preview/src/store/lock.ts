import { hostname } from 'node:os';
import {
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * One writer at a time (spec §3): every operation in the Gateway and every resolver run holds
 * `<state>/falcon-vault/vault.lock`.
 *
 * Node has no flock, and the resolver is a separate process, so the lock is the file's existence:
 * it is created with O_EXCL and removed on release. It records who holds it, so a holder that died
 * (a crashed Gateway, a killed resolver) is recognised and its lock broken: its process is gone, or
 * it has held the lock far longer than any operation takes. Within one process, a promise chain
 * keeps callers in line before they reach the file.
 */

/** No operation holds the lock this long; a lock older than this was left by a holder that died. */
const STALE_MS = 30_000;

type Holder = { pid: number; host: string; at: number; token: string };

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

function holderOf(text: string): Holder | null {
	try {
		const h = JSON.parse(text);
		return typeof h?.pid === 'number' && typeof h?.at === 'number' ? h : null;
	} catch {
		return null;
	}
}

const isStale = (h: Holder | null, now: number) =>
	!h || now - h.at > STALE_MS || (h.host === hostname() && !alive(h.pid));

/** Break a dead holder's lock, without breaking one a live process took in the meantime. */
function breakStale(file: string, seen: string) {
	const aside = `${file}.${randomBytes(6).toString('hex')}.stale`;
	try {
		renameSync(file, aside);
	} catch {
		return; // already gone
	}
	try {
		if (readFileSync(aside, 'utf8') !== seen)
			try {
				linkSync(aside, file); // someone else's fresh lock: put it back
			} catch {
				/* a third holder already took it */
			}
	} finally {
		unlinkSync(aside);
	}
}

function tryAcquire(file: string): Holder | null {
	const me: Holder = {
		pid: process.pid,
		host: hostname(),
		at: Date.now(),
		token: randomBytes(8).toString('hex')
	};
	let fd: number;
	try {
		fd = openSync(file, 'wx', 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		let seen = '';
		try {
			seen = readFileSync(file, 'utf8');
		} catch {
			return null; // released while we looked
		}
		// A holder may have created the file and not yet written to it; give it a moment.
		const now = Date.now();
		const empty = !seen && now - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? now) > 2000;
		if (empty || (seen && isStale(holderOf(seen), now))) breakStale(file, seen);
		return null;
	}
	try {
		writeSync(fd, JSON.stringify(me));
	} finally {
		closeSync(fd);
	}
	return me;
}

function release(file: string, me: Holder) {
	try {
		if (holderOf(readFileSync(file, 'utf8'))?.token === me.token) unlinkSync(file);
	} catch {
		/* already gone */
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const queues = new Map<string, Promise<unknown>>();

/** Run `fn` holding the lock file. Waits up to `timeoutMs` for another holder to finish. */
export function withLock<T>(file: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
	const run = async () => {
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + timeoutMs;
		let me = tryAcquire(file);
		for (let wait = 10; !me; wait = Math.min(wait * 2, 100)) {
			if (Date.now() > deadline)
				throw new Error('Falcon Vault is busy: another operation holds its lock');
			await sleep(wait);
			me = tryAcquire(file);
		}
		try {
			return await fn();
		} finally {
			release(file, me);
		}
	};
	const previous = queues.get(file) ?? Promise.resolve();
	const next = previous.then(run, run);
	const settled = next.catch(() => undefined);
	queues.set(file, settled);
	void settled.then(() => queues.get(file) === settled && queues.delete(file));
	return next;
}
