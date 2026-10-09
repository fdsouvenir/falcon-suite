import path from 'node:path';
import { existsSync } from 'node:fs';
import { Audit } from './store/audit.js';
import { fieldText, type KdbxEntry } from './store/kdbx.js';
import { allEntries, inRecycleBin } from './store/model.js';
import { AUDIT_FILE, DATA_DIR, parseReference, validReference } from './store/paths.js';
import { Vault } from './store/vault.js';

/**
 * The SecretRef resolver (spec §5): OpenClaw's exec-provider protocol v1. OpenClaw starts it as a
 * separate process (`bin/resolve-secrets.mjs`), writes one request to stdin and reads one response
 * from stdout, its protected resolver pipe. Values go to stdout and nowhere else: not stderr, not
 * audit, not errors.
 */

export const MAX_INPUT_BYTES = 16 * 1024;
export const MAX_IDS = 50;

export class ProtocolError extends Error {}

/**
 * Where the Gateway keeps its state. OpenClaw runs exec providers with an empty environment
 * except what the provider passes on, so the resolver does not guess from HOME:
 *
 * 1. `OPENCLAW_STATE_DIR`, when the Gateway has one: the manifest's integration passes it on
 *    (`passEnv`), and it is the state directory itself.
 * 2. Otherwise the plugin's own location. OpenClaw installs plugins only under the state
 *    directory, `<state>/extensions/<plugin>/` or `<state>/npm/node_modules/<package>/`, and only
 *    exposes the integrations of installed plugins, so the resolver's path names its state dir.
 */
export function locateStateDir(env: NodeJS.ProcessEnv, scriptFile: string): string | null {
	const given = env.OPENCLAW_STATE_DIR?.trim();
	if (given && path.isAbsolute(given)) return given;
	const parts = path.resolve(scriptFile).split(path.sep);
	for (let i = parts.length - 2; i > 0; i--) {
		if (parts[i] === 'extensions') return parts.slice(0, i).join(path.sep) || path.sep;
		if (parts[i] === 'node_modules' && parts[i - 1] === 'npm')
			return parts.slice(0, i - 1).join(path.sep) || path.sep;
	}
	return null;
}

/** Parse and bound one request (16 KiB, at most 50 well-typed ids). */
export function parseRequest(raw: string): string[] {
	if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES)
		throw new ProtocolError('request is larger than 16 KiB');
	let req: unknown;
	try {
		req = JSON.parse(raw);
	} catch {
		throw new ProtocolError('request is not JSON');
	}
	const r = req as { protocolVersion?: unknown; ids?: unknown };
	if (r?.protocolVersion !== 1) throw new ProtocolError('unsupported protocolVersion');
	if (!Array.isArray(r.ids) || r.ids.some((id) => typeof id !== 'string'))
		throw new ProtocolError('ids must be a list of strings');
	if (r.ids.length > MAX_IDS) throw new ProtocolError(`more than ${MAX_IDS} ids`);
	return [...new Set(r.ids as string[])];
}

type Response = {
	protocolVersion: 1;
	values: Record<string, string>;
	errors?: Record<string, { code: string }>;
};

/**
 * Resolve ids from the Vault in `stateDir`, under the lock. Each id is `Path` (its Password) or
 * `Path:Field`. Anything not found, empty, in the Recycle Bin or not well formed is `NOT_FOUND`
 * for that id alone, saying nothing about other entries. Each id is one audit Event.
 */
export async function resolveIds(stateDir: string, ids: string[]): Promise<Response> {
	const vault = new Vault(stateDir, 4_000); // inside OpenClaw's default 5 s exec timeout
	await vault.open({ create: false });
	const found = await vault.read((db) => {
		const out = new Map<string, string | 'ambiguous'>();
		const wanted = new Map(ids.filter(validReference).map((id) => [id, parseReference(id)]));
		const paths = new Set([...wanted.values()].map((w) => w.path));
		const byPath = new Map<string, KdbxEntry[]>();
		for (const { entry, path: p } of allEntries(db))
			if (paths.has(p) && !inRecycleBin(db, entry))
				byPath.set(p, [...(byPath.get(p) ?? []), entry]);
		for (const [id, w] of wanted) {
			const entries = byPath.get(w.path) ?? [];
			if (entries.length > 1) out.set(id, 'ambiguous');
			else if (entries.length === 1) {
				const value = fieldText(entries[0], w.field);
				if (value) out.set(id, value);
			}
		}
		return out;
	});
	const response: Response = { protocolVersion: 1, values: {} };
	const errors: Record<string, { code: string }> = {};
	let audit: Audit | null = null;
	try {
		audit = new Audit(path.join(stateDir, DATA_DIR, AUDIT_FILE));
	} catch {
		/* resolution still works; history misses these reads */
	}
	const at = new Date().toISOString();
	for (const id of ids) {
		const v = found.get(id);
		if (v === undefined || v === 'ambiguous')
			errors[id] = { code: v ? 'AMBIGUOUS_DUPLICATE_KEY' : 'NOT_FOUND' };
		else response.values[id] = v;
		const { path: p, field } = parseReference(id);
		try {
			audit?.record({
				at,
				actor: 'resolver',
				action: 'resolve',
				path: p,
				outcome: v === undefined ? 'not_found' : v === 'ambiguous' ? 'rejected' : 'ok',
				detail: { field }
			});
		} catch {
			/* as above */
		}
	}
	audit?.close();
	if (Object.keys(errors).length) response.errors = errors;
	return response;
}

/** The whole run: request in, response out. Returns the exit code; writes nothing but `out`. */
export async function main(
	raw: string,
	env: NodeJS.ProcessEnv,
	scriptFile: string,
	out: (text: string) => void,
	fail: (reason: string) => void
): Promise<number> {
	let ids: string[];
	try {
		ids = parseRequest(raw);
	} catch (error) {
		fail(`falcon-vault resolver: ${(error as Error).message}`);
		return 2;
	}
	const stateDir = locateStateDir(env, scriptFile);
	if (!stateDir || !existsSync(stateDir)) {
		fail('falcon-vault resolver: cannot find the Gateway state directory');
		return 1;
	}
	try {
		out(JSON.stringify(await resolveIds(stateDir, ids)));
		return 0;
	} catch (error) {
		// The reason names files and states, never a value.
		fail(`falcon-vault resolver: ${(error as Error).message}`);
		return 1;
	}
}
