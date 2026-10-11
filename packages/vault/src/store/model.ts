import { fieldText, type Kdbx, type KdbxEntry, type KdbxGroup } from './kdbx.js';
import { joinPath } from './paths.js';

/**
 * Paths over a loaded database (spec §2, §4). A path is the chain of group names below the root
 * group, then the title: `Services/Cloudflare/API token`. Identity is the exact path string; two
 * entries with the same path are ambiguous, and nothing is ever matched by title alone.
 */

export class Rejection extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}
export const reject = (code: string, message: string): never => {
	throw new Rejection(code, message);
};

export const rootOf = (db: Kdbx) => db.getDefaultGroup();

export function recycleBinOf(db: Kdbx): KdbxGroup | null {
	if (!db.meta.recycleBinEnabled || !db.meta.recycleBinUuid) return null;
	return db.getGroup(db.meta.recycleBinUuid) ?? null;
}

export function groupPath(db: Kdbx, group: KdbxGroup): string {
	const names: string[] = [];
	for (let g: KdbxGroup | undefined = group; g && g !== rootOf(db); g = g.parentGroup)
		names.unshift(g.name ?? '');
	return names.join('/');
}

export const entryPath = (db: Kdbx, entry: KdbxEntry) =>
	joinPath(entry.parentGroup ? groupPath(db, entry.parentGroup) : '', fieldText(entry, 'Title'));

/** Whether a group or entry sits in the Recycle Bin (at any depth). */
export function inRecycleBin(db: Kdbx, item: KdbxEntry | KdbxGroup): boolean {
	const bin = recycleBinOf(db);
	if (!bin) return false;
	for (let g: KdbxGroup | undefined = item as KdbxGroup; g; g = g.parentGroup)
		if (g === bin) return true;
	return false;
}

/** Every entry, with its path. */
export function allEntries(db: Kdbx): { entry: KdbxEntry; path: string }[] {
	const out: { entry: KdbxEntry; path: string }[] = [];
	for (const entry of rootOf(db).allEntries()) out.push({ entry, path: entryPath(db, entry) });
	return out;
}

/** Every group below the root, with its path. */
export function allGroups(db: Kdbx): { group: KdbxGroup; path: string }[] {
	const out: { group: KdbxGroup; path: string }[] = [];
	for (const group of rootOf(db).allGroups())
		if (group !== rootOf(db)) out.push({ group, path: groupPath(db, group) });
	return out;
}

/**
 * The one entry at exactly this path. `uuid` picks between entries that share a path (the UI
 * knows which one it showed); without it, a shared path is rejected rather than guessed.
 */
export function entryAt(db: Kdbx, path: string, uuid?: string): KdbxEntry {
	const matches = allEntries(db).filter((e) => e.path === path);
	if (uuid) {
		const m = matches.find((e) => e.entry.uuid.id === uuid);
		if (m) return m.entry;
		return reject('not_found', `No entry at ${path}`);
	}
	if (matches.length === 1) return matches[0].entry;
	if (!matches.length) return reject('not_found', `No entry at ${path}`);
	return reject(
		'ambiguous',
		`${matches.length} entries share the path ${path}; supply the entry UUID or ask the person to rename one`
	);
}

export const hasEntryAt = (db: Kdbx, path: string) => allEntries(db).some((e) => e.path === path);

/** The group at this path; '' is the root. */
export function groupAt(db: Kdbx, path: string): KdbxGroup {
	if (path === '') return rootOf(db);
	const matches = allGroups(db).filter((g) => g.path === path);
	if (matches.length === 1) return matches[0].group;
	if (!matches.length) return reject('not_found', `No group ${path}`);
	return reject('ambiguous', `${matches.length} groups share the path ${path}`);
}

export const hasGroupAt = (db: Kdbx, path: string) =>
	path === '' || allGroups(db).some((g) => g.path === path);

/** Group names cannot hold `/`: it would make paths ambiguous. */
export function checkName(name: string, what: string): string {
	const n = name.trim();
	if (!n) reject('invalid_input', `${what} cannot be empty`);
	if (n.includes('/')) reject('invalid_input', `${what} cannot contain "/"`);
	if (n.length > 240) reject('invalid_input', `${what} is too long`);
	return n;
}
