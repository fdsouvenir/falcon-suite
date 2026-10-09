import path from 'node:path';
import { PLUGIN_ID } from '../identity.js';
import { Audit } from '../store/audit.js';
import { VaultOps } from '../store/ops.js';
import { AUDIT_FILE, DATA_DIR } from '../store/paths.js';
import { Vault, VaultUnavailable } from '../store/vault.js';

/**
 * The Vault, opened by whichever registration of this plugin needs it first (as with Work: hot
 * reloads re-register the plugin, and the new registration's service may not start). Only the
 * Gateway's state directory is shared across registrations; each copy of the code opens its own
 * Vault, and the lock file keeps them, and the resolver, one at a time.
 */
const KEY = Symbol.for(`${PLUGIN_ID}.stateDir`);
const shared = globalThis as Record<symbol, string | undefined>;
let opened: Promise<VaultOps> | null = null;
let failure: string | null = null;

/** Called by the service with the Gateway's real state directory. */
export function startVault(stateDir: string): Promise<VaultOps> {
	shared[KEY] = stateDir;
	if (opened) return opened;
	failure = null;
	const attempt = (async () => {
		const vault = new Vault(stateDir);
		await vault.open();
		return new VaultOps(vault, new Audit(path.join(stateDir, DATA_DIR, AUDIT_FILE)));
	})();
	opened = attempt;
	attempt.catch((error) => {
		failure = (error as Error).message;
		if (opened === attempt) opened = null; // the next use tries again
	});
	return attempt;
}

/** The Vault, opening it if this registration's service has not started yet. */
export function currentVault(): Promise<VaultOps> {
	if (opened) return opened;
	const dir = shared[KEY] ?? process.env.OPENCLAW_STATE_DIR;
	if (!dir)
		return Promise.reject(new VaultUnavailable('The Gateway has not started Falcon Vault yet'));
	return startVault(dir);
}

/** Why the last attempt to open the Vault failed, if it did. */
export const lastFailure = () => failure;

/** For tests: forget the Vault and its location. */
export function resetVault(): void {
	void opened?.then((ops) => ops.audit.close()).catch(() => {});
	opened = null;
	failure = null;
	shared[KEY] = undefined;
}
