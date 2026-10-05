import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ID } from '../identity.js';
import { Work } from '../store/work.js';

/**
 * One Work store per Gateway process, shared by every registration of this plugin.
 *
 * OpenClaw re-registers a plugin on every hot reload (config changes, plugin updates) and retires
 * the old registration later. A store held in one registration's closure is invisible to the next,
 * and closing it on retirement breaks the registration that replaced it. So the store lives on the
 * process, opens on first use, and is never closed by a retiring registration.
 */
type Runtime = { work: Work | null; stateDir: string | null };
const KEY = Symbol.for(`${PLUGIN_ID}.runtime`);
const shared = (): Runtime =>
	((globalThis as Record<symbol, Runtime | undefined>)[KEY] ??= { work: null, stateDir: null });

/** Called by the service with the Gateway's real state directory. */
export function startWork(stateDir: string): Work {
	const r = shared();
	r.stateDir = stateDir;
	return (r.work ??= new Work(path.join(stateDir, PLUGIN_ID, 'work.db'), 'person:gateway-owner'));
}

/** The store, opening it if this registration's service has not started yet. */
export function currentWork(): Work {
	const r = shared();
	if (r.work) return r.work;
	return startWork(
		r.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), '.openclaw')
	);
}

/** For tests: forget the process-wide store. */
export function resetWork(): void {
	const r = shared();
	r.work?.close();
	r.work = null;
	r.stateDir = null;
}
