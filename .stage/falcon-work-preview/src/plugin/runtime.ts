import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ID } from '../identity.js';
import { Work } from '../store/work.js';

/**
 * The Work store, opened lazily by whichever registration of this plugin needs it first.
 *
 * OpenClaw re-registers a plugin on every hot reload (config changes, plugin updates) and retires
 * the old registration later, and the new registration's service may not start. So the store is
 * not tied to a registration: it opens on first use and is never closed by a retiring one.
 *
 * Only the data location is shared across the process. The store itself belongs to this copy of
 * the code: a plugin update loads new code into the same process, and sharing the store object
 * would keep running the old version's commands and views until the Gateway restarts. Each
 * version opens its own connection to the same database (WAL with a busy timeout, so they
 * coexist while the old registration drains).
 */
const KEY = Symbol.for(`${PLUGIN_ID}.stateDir`);
const shared = globalThis as Record<symbol, string | undefined>;
let work: Work | null = null;

/** Called by the service with the Gateway's real state directory. */
export function startWork(stateDir: string): Work {
	shared[KEY] = stateDir;
	return (work ??= new Work(path.join(stateDir, PLUGIN_ID, 'work.db'), 'person:gateway-owner'));
}

/** The store, opening it if this registration's service has not started yet. */
export function currentWork(): Work {
	if (work) return work;
	return startWork(
		shared[KEY] ?? process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), '.openclaw')
	);
}

/** Work's own data folder on this Gateway (the store and the decision log live here). */
export function dataDir(): string {
	return path.join(
		shared[KEY] ?? process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), '.openclaw'),
		PLUGIN_ID
	);
}

/** For tests: forget the store and its location. */
export function resetWork(): void {
	work?.close();
	work = null;
	shared[KEY] = undefined;
}
