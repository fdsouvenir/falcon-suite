import {
	Audit,
	type Event,
	type HistoryFilter,
	type Outcome as AuditOutcome,
	type Request
} from './audit.js';
import { fieldText, kdbxweb, setField, type Kdbx, type KdbxEntry } from './kdbx.js';
import {
	allEntries,
	allGroups,
	checkName,
	entryAt,
	entryPath,
	groupAt,
	groupPath,
	hasEntryAt,
	hasGroupAt,
	inRecycleBin,
	recycleBinOf,
	reject,
	Rejection,
	rootOf
} from './model.js';
import { groupOf, joinPath, referenceFor, type Field } from './paths.js';
import { usagesOf, type Usage } from './usages.js';
import { Vault } from './vault.js';

/**
 * Vault's operations (spec §4–§8), shared by the agent tool and the Control UI. Each one is an
 * attempt recorded in audit history with its outcome. Metadata stays separate from explicit `retrieve`, UI `reveal`, and the person’s `entry` view.
 */

/** `person:<id>`, `agent:<id>` or `resolver`. */
export type Actor = string;

export type Committed = {
	outcome: 'committed';
	path: string;
	reference: string | null;
	[k: string]: unknown;
};
export type Rejected = { outcome: 'rejected'; code: string; reason: string };
export type Result = Committed | Rejected;

export type EntrySummary = {
	uuid: string;
	path: string;
	group: string;
	title: string;
	username: string;
	url: string;
	/** Which standard fields hold something; never their values. */
	set: { Password: boolean; UserName: boolean; URL: boolean; Notes: boolean };
	reference: string | null;
	reference_problem: string | null;
	recycled: boolean;
	/** For an entry in the Recycle Bin: the group it was removed from, when the file says. */
	from: string | null;
	/** An open Request (spec §7): the entry has no password yet and an agent asked for one. */
	request: { actor: string; at: string; reason: string } | null;
	modified: string | null;
};

export type GroupNode = { path: string; name: string; count: number; children: GroupNode[] };

export type EntryFields = {
	title?: string;
	group?: string;
	username?: string;
	password?: string;
	url?: string;
	notes?: string;
};

const LIMIT = { title: 240, username: 1000, password: 10_000, url: 2000, notes: 20_000 };

function checkFields(f: EntryFields) {
	for (const [k, max] of Object.entries(LIMIT)) {
		const v = f[k as keyof EntryFields];
		if (v !== undefined && typeof v !== 'string') reject('invalid_input', `${k} must be text`);
		if (typeof v === 'string' && v.length > max) reject('invalid_input', `${k} is too long`);
	}
	if (f.group !== undefined && f.group.split('/').some((n) => !n.trim()) && f.group !== '')
		reject('invalid_input', 'group has an empty part');
}

export class VaultOps {
	constructor(
		readonly vault: Vault,
		readonly audit: Audit,
		readonly now: () => Date = () => new Date()
	) {}

	// ---------------------------------------------------------------- reads

	/** The group tree and counts (spec §9): groups, Needs a value, Recycle Bin. */
	overview() {
		return this.vault.read((db) => {
			const requests = this.requests(db);
			const bin = recycleBinOf(db);
			const count = (g: kdbxweb.KdbxGroup) => [...g.allEntries()].length;
			const node = (g: kdbxweb.KdbxGroup): GroupNode => ({
				path: groupPath(db, g),
				name: g.name ?? '',
				count: count(g),
				children: g.groups.filter((c) => c !== bin).map(node)
			});
			const root = rootOf(db);
			const total = allEntries(db).filter((e) => !inRecycleBin(db, e.entry)).length;
			return {
				name: root.name ?? '',
				total,
				needs: requests.size,
				groups: root.groups.filter((g) => g !== bin).map(node),
				root_entries: root.entries.length,
				recycle_bin: bin ? { path: groupPath(db, bin), count: count(bin) } : null
			};
		});
	}

	/** Entries in a group (with its subgroups), in the Recycle Bin, awaiting a value, or matching a search. */
	list(f: { group?: string; scope?: 'all' | 'group' | 'needs' | 'recycle'; search?: string }) {
		return this.vault.read((db) => {
			const requests = this.requests(db);
			const bin = recycleBinOf(db);
			const binPath = bin ? groupPath(db, bin) : null;
			const q = f.search?.trim().toLowerCase();
			let rows = allEntries(db);
			const scope = q ? 'all' : (f.scope ?? (f.group !== undefined ? 'group' : 'all'));
			if (scope === 'recycle') rows = rows.filter((r) => inRecycleBin(db, r.entry));
			else rows = rows.filter((r) => !inRecycleBin(db, r.entry));
			if (scope === 'needs') rows = rows.filter((r) => requests.has(r.path));
			if (scope === 'group' && f.group) {
				if (f.group === binPath) rows = allEntries(db).filter((r) => inRecycleBin(db, r.entry));
				else {
					const g = groupAt(db, f.group);
					const inside = new Set(g.allEntries());
					rows = rows.filter((r) => inside.has(r.entry));
				}
			}
			if (q)
				rows = rows.filter((r) =>
					[r.path, fieldText(r.entry, 'UserName'), fieldText(r.entry, 'URL')].some((s) =>
						s.toLowerCase().includes(q)
					)
				);
			return rows
				.map((r) => this.summary(db, r.entry, r.path, requests))
				.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
		});
	}

	/** One entry for a person: its fields except Password, its Usages and its recent history. */
	entry(path: string, uuid: string | undefined, config: unknown, pluginId: string) {
		return this.vault.read((db) => {
			const e = entryAt(db, path, uuid);
			const requests = this.requests(db);
			return {
				...this.summary(db, e, path, requests),
				notes: fieldText(e, 'Notes'),
				usages: usagesOf(config, pluginId, path, e.uuid.id),
				duplicates: allEntries(db).filter((x) => x.path === path).length - 1,
				versions: versionsOf(e),
				history: this.audit.history({ entry: e.uuid.id, path, limit: 40 })
			};
		});
	}

	/** Metadata for agents (spec §7): no Password or Notes value, ever. */
	agentEntry(path: string, config: unknown, pluginId: string) {
		return this.vault.read((db) => {
			const e = entryAt(db, path);
			if (inRecycleBin(db, e)) reject('not_found', `No entry at ${path}`);
			return {
				...this.summary(db, e, path, this.requests(db)),
				usages: usagesOf(config, pluginId, path, e.uuid.id)
			};
		});
	}

	/** Paths of groups and entries for an agent, optionally under a group or matching a search. */
	agentList(f: { group?: string; search?: string; limit?: number }) {
		return this.vault.read((db) => {
			const requests = this.requests(db);
			const under = f.group ? `${f.group}/` : '';
			const q = f.search?.trim().toLowerCase();
			const groups = allGroups(db)
				.filter((g) => !inRecycleBin(db, g.group))
				.map((g) => g.path)
				.filter((p) => !under || p.startsWith(under) || p === f.group);
			if (f.group && !groups.includes(f.group)) reject('not_found', `No group ${f.group}`);
			const entries = allEntries(db)
				.filter((r) => !inRecycleBin(db, r.entry))
				.filter((r) => !under || r.path.startsWith(under))
				.filter(
					(r) =>
						!q ||
						[r.path, fieldText(r.entry, 'UserName'), fieldText(r.entry, 'URL')].some((s) =>
							s.toLowerCase().includes(q)
						)
				)
				.map((r) => this.summary(db, r.entry, r.path, requests))
				.sort((a, b) => a.path.localeCompare(b.path));
			const limit = f.limit ?? 200;
			return {
				groups: q ? [] : groups.sort(),
				entries: entries.slice(0, limit),
				...(entries.length > limit ? { truncated: entries.length - limit } : {})
			};
		});
	}

	history(f: HistoryFilter) {
		return this.audit.history(f);
	}

	// ---------------------------------------------------------------- changes

	/** A new entry with all its fields (Vault tab: New entry; agent: store). Create-only. */
	create(actor: Actor, f: EntryFields, opts: { key?: string; action?: string } = {}) {
		const action = opts.action ?? 'create_entry';
		const path = joinPath(f.group ?? '', (f.title ?? '').trim());
		return this.attempt(actor, action, path, opts.key, async (commit) => {
			checkFields(f);
			const title = checkName(f.title ?? '', 'Title');
			if (f.group) for (const n of f.group.split('/')) checkName(n, 'Group name');
			return commit((db) => {
				if (hasEntryAt(db, path)) reject('exists', `An entry already exists at ${path}`);
				const group = this.ensureGroup(db, f.group ?? '');
				const e = db.createEntry(group);
				setField(e, 'Title', title);
				setField(e, 'UserName', f.username ?? '');
				setField(e, 'Password', f.password ?? '');
				setField(e, 'URL', f.url ?? '');
				setField(e, 'Notes', f.notes ?? '');
				return {
					path,
					entry: e.uuid.id,
					reference: referenceFor(e.uuid.id),
					detail: { fields: setNames(f) }
				};
			});
		});
	}

	/** An agent's Request (spec §7): every field but the password, plus why. Never overwrites. */
	request(
		actor: Actor,
		f: EntryFields & { reason: string; session?: string | null },
		key?: string
	) {
		const path = joinPath(f.group ?? '', (f.title ?? '').trim());
		return this.attempt(actor, 'request', path, key, async (commit) => {
			checkFields(f);
			const reason = f.reason?.trim();
			if (!reason) reject('invalid_input', 'Say in one line why you need it (reason)');
			if (reason.length > 500) reject('invalid_input', 'reason is too long');
			const title = checkName(f.title ?? '', 'Title');
			if (f.group) for (const n of f.group.split('/')) checkName(n, 'Group name');
			return commit((db) => {
				if (hasEntryAt(db, path)) reject('exists', `An entry already exists at ${path}`);
				const e = db.createEntry(this.ensureGroup(db, f.group ?? ''));
				setField(e, 'Title', title);
				setField(e, 'UserName', f.username ?? '');
				setField(e, 'Password', '');
				setField(e, 'URL', f.url ?? '');
				setField(e, 'Notes', f.notes ?? '');
				return {
					path,
					entry: e.uuid.id,
					reference: referenceFor(e.uuid.id),
					detail: { reason, session: f.session ?? null }
				};
			});
		});
	}

	/**
	 * Edit any field, rename (title) or move (group), in one write. A person's action, and an
	 * agent's `update` (`live`: the entry must be outside the Recycle Bin and stay out of it).
	 * The entry as it was is kept first as a previous version, as KeePassXC does.
	 */
	update(
		actor: Actor,
		at: { path: string; uuid?: string },
		f: EntryFields,
		key?: string,
		opts: { live?: boolean } = {}
	) {
		return this.attempt(actor, 'edit_entry', at.path, key, async (commit) => {
			checkFields(f);
			return commit((db) => {
				const e = entryAt(db, at.path, at.uuid);
				if (opts.live && inRecycleBin(db, e)) reject('not_found', `No entry at ${at.path}`);
				const title = f.title !== undefined ? checkName(f.title, 'Title') : fieldText(e, 'Title');
				const groupPathNow = e.parentGroup ? groupPath(db, e.parentGroup) : '';
				const group = f.group ?? groupPathNow;
				if (f.group !== undefined && f.group !== '') {
					for (const n of f.group.split('/')) checkName(n, 'Group name');
					if (!hasGroupAt(db, f.group)) reject('not_found', `No group ${f.group}`);
					if (opts.live && inRecycleBin(db, groupAt(db, f.group)))
						reject('invalid_input', 'Use recycle to move an entry to the Recycle Bin');
				}
				const to = joinPath(group, title);
				if (to !== at.path && hasEntryAt(db, to))
					reject('exists', `An entry already exists at ${to}`);
				const changes = (
					[
						['Title', f.title !== undefined ? title : undefined],
						['UserName', f.username],
						['Password', f.password],
						['URL', f.url],
						['Notes', f.notes]
					] as const
				).filter(([name, v]) => v !== undefined && v !== fieldText(e, name));
				if (changes.length) {
					keepVersion(db, e);
					for (const [name, v] of changes) setField(e, name, v!);
					e.times.update();
				}
				if (group !== groupPathNow) db.move(e, groupAt(db, group));
				return {
					path: to,
					entry: e.uuid.id,
					reference: inRecycleBin(db, e) ? null : referenceFor(e.uuid.id),
					detail: {
						fields: changes.map(([name]) => name),
						...(to !== at.path ? { to } : {})
					}
				};
			});
		});
	}

	/**
	 * A person puts back one previous version's fields (Title, UserName, Password, URL, Notes). What
	 * the entry holds now is kept as a previous version first, so a restore can be undone too.
	 */
	restoreVersion(actor: Actor, at: { path: string; uuid?: string }, version: number, key?: string) {
		return this.attempt(actor, 'restore_version', at.path, key, async (commit) =>
			commit((db) => {
				const e = entryAt(db, at.path, at.uuid);
				if (inRecycleBin(db, e)) reject('invalid_input', 'Restore it from the Recycle Bin first');
				const v =
					(Number.isInteger(version) ? e.history[version] : undefined) ??
					reject('not_found', 'No such previous version');
				const group = e.parentGroup ? groupPath(db, e.parentGroup) : '';
				const to = joinPath(group, fieldText(v, 'Title'));
				if (to !== at.path && hasEntryAt(db, to))
					reject('exists', `An entry already exists at ${to}`);
				const fields = STANDARD.filter((name) => fieldText(v, name) !== fieldText(e, name));
				if (!fields.length) reject('invalid_input', 'The entry already matches that version');
				const from = v.times.lastModTime?.toISOString() ?? null;
				keepVersion(db, e);
				for (const name of fields) setField(e, name, fieldText(v, name));
				e.times.update();
				return {
					path: to,
					entry: e.uuid.id,
					reference: referenceFor(e.uuid.id),
					detail: { fields, version_of: from, ...(to !== at.path ? { to } : {}) }
				};
			})
		);
	}

	/** Remove: to the Recycle Bin, as KeePassXC does (spec §4). Forever when the database has none. */
	recycle(actor: Actor, at: { path: string; uuid?: string }, key?: string) {
		return this.attempt(actor, 'recycle_entry', at.path, key, async (commit) =>
			commit((db) => {
				const e = entryAt(db, at.path, at.uuid);
				if (inRecycleBin(db, e)) reject('invalid_input', 'It is already in the Recycle Bin');
				db.remove(e);
				const to = inRecycleBin(db, e) ? entryPath(db, e) : null;
				return { path: at.path, entry: e.uuid.id, detail: to ? { to } : { forever: true } };
			})
		);
	}

	/** Delete forever, from the Recycle Bin only (spec §9). */
	deleteForever(actor: Actor, at: { path: string; uuid?: string }, key?: string) {
		return this.attempt(actor, 'delete_forever', at.path, key, async (commit) =>
			commit((db) => {
				const e = entryAt(db, at.path, at.uuid);
				if (!inRecycleBin(db, e))
					reject('invalid_input', 'Only entries in the Recycle Bin can be deleted forever');
				db.move(e, null);
				return { path: at.path, entry: e.uuid.id };
			})
		);
	}

	/** A person reveals or copies one field of one entry, or of one of its previous versions (spec §6). */
	async reveal(
		actor: Actor,
		at: { path: string; uuid?: string },
		field: Field,
		purpose: 'reveal' | 'copy',
		version?: number
	) {
		let value = '';
		const r = await this.attempt(actor, purpose, at.path, undefined, async () =>
			this.vault.read((db) => {
				const e = entryAt(db, at.path, at.uuid);
				const from =
					(version === undefined ? e : e.history[version]) ??
					reject('not_found', 'No such previous version');
				value = fieldText(from, field);
				return {
					path: at.path,
					entry: e.uuid.id,
					detail: {
						field,
						...(version !== undefined
							? { version_of: from.times.lastModTime?.toISOString() ?? null }
							: {})
					}
				};
			})
		);
		return r.outcome === 'committed' ? { ...r, value } : r;
	}

	/** Explicit agent read, independent of the SecretRef subprocess. Audit before releasing a value. */
	async retrieve(
		actor: Actor,
		at: { path: string; uuid?: string },
		field: Field,
		context: { session: string | null }
	) {
		const detail: Record<string, unknown> = {
			field,
			session: context.session,
			...(at.uuid ? { uuid: at.uuid } : {})
		};
		let value: string;
		try {
			if (!at.path) reject('invalid_input', 'retrieve: give the entry path');
			value = await this.vault.read((db) => {
				const entry = entryAt(db, at.path, at.uuid);
				if (inRecycleBin(db, entry)) reject('not_found', `No entry at ${at.path}`);
				detail.entry = entry.uuid.id;
				return fieldText(entry, field);
			});
		} catch (error) {
			const known = error instanceof Rejection;
			this.audit.record({
				actor,
				action: 'retrieve',
				path: at.path,
				outcome: known ? (error.code === 'not_found' ? 'not_found' : 'rejected') : 'failed',
				detail: { ...detail, code: known ? error.code : 'read_failed' }
			});
			return {
				outcome: 'rejected' as const,
				code: known ? error.code : 'unavailable',
				reason: known ? error.message : 'Vault credential read failed'
			};
		}
		this.audit.record({ actor, action: 'retrieve', path: at.path, outcome: 'ok', detail });
		return { outcome: 'retrieved' as const, path: at.path, field, value };
	}

	/** A person fills a Request's password (spec §9). Returns whom to tell. */
	async fill(actor: Actor, at: { path: string; uuid?: string }, password: string, key?: string) {
		let request: Request | null = null;
		const r = await this.attempt(actor, 'fill_request', at.path, key, async (commit) => {
			if (!password) reject('invalid_input', 'Enter the password');
			checkFields({ password });
			return commit((db) => {
				const e = entryAt(db, at.path, at.uuid);
				const asked =
					this.requests(db).get(at.path) ??
					reject('not_found', `${at.path} is not waiting for a value`);
				request = asked;
				setField(e, 'Password', password);
				e.times.update();
				return {
					path: at.path,
					entry: e.uuid.id,
					reference: referenceFor(e.uuid.id),
					detail: { requested_by: asked.actor }
				};
			});
		});
		return { result: r, request: r.outcome === 'committed' ? (request as Request | null) : null };
	}

	/** A person declines a Request: it leaves Needs a value and goes to the Recycle Bin. */
	async dismiss(actor: Actor, at: { path: string; uuid?: string }, key?: string) {
		let request: Request | null = null;
		const r = await this.attempt(actor, 'dismiss_request', at.path, key, async (commit) =>
			commit((db) => {
				const e = entryAt(db, at.path, at.uuid);
				const asked =
					this.requests(db).get(at.path) ??
					reject('not_found', `${at.path} is not waiting for a value`);
				request = asked;
				db.remove(e);
				return { path: at.path, entry: e.uuid.id, detail: { requested_by: asked.actor } };
			})
		);
		return { result: r, request: r.outcome === 'committed' ? (request as Request | null) : null };
	}

	createGroup(actor: Actor, parent: string, name: string, key?: string) {
		const path = joinPath(parent, name.trim());
		return this.attempt(actor, 'create_group', path, key, async () => {
			const n = checkName(name, 'Group name');
			await this.vault.change((db) => {
				const p = groupAt(db, parent);
				if (inRecycleBin(db, p))
					reject('invalid_input', 'Groups cannot be created in the Recycle Bin');
				if (p.groups.some((g) => g.name === n))
					reject('exists', `A group already exists at ${path}`);
				db.createGroup(p, n);
			});
			return { path };
		});
	}

	/** Rename group (spec §4): one write. Its entries' paths change with it. */
	renameGroup(actor: Actor, path: string, name: string, key?: string) {
		const to = joinPath(groupOf(path), name.trim());
		return this.attempt(actor, 'rename_group', path, key, async () => {
			const n = checkName(name, 'Group name');
			await this.vault.change((db) => {
				const g = this.ownGroup(db, path);
				if (g.parentGroup?.groups.some((s) => s !== g && s.name === n))
					reject('exists', `A group already exists at ${to}`);
				g.name = n;
				g.times.update();
			});
			return { path: to, detail: { to } };
		});
	}

	/** Move group to another parent ('' is the top level). */
	moveGroup(actor: Actor, path: string, parent: string, key?: string) {
		return this.attempt(actor, 'move_group', path, key, async () => {
			const to = await this.vault.change((db) => {
				const g = this.ownGroup(db, path);
				const p = groupAt(db, parent);
				for (let x: kdbxweb.KdbxGroup | undefined = p; x; x = x.parentGroup)
					if (x === g) reject('invalid_input', 'A group cannot move into itself');
				if (inRecycleBin(db, p)) reject('invalid_input', 'Use Delete group to remove a group');
				if (p.groups.some((s) => s !== g && s.name === g.name))
					reject('exists', `A group already exists at ${joinPath(parent, g.name ?? '')}`);
				db.move(g, p);
				return groupPath(db, g);
			});
			return { path: to, detail: { to } };
		});
	}

	/** Delete group, only when it is empty (spec §9). */
	deleteGroup(actor: Actor, path: string, key?: string) {
		return this.attempt(actor, 'delete_group', path, key, async () => {
			await this.vault.change((db) => {
				const g = this.ownGroup(db, path);
				if (g.entries.length || g.groups.length)
					reject('not_empty', `${path} is not empty: move or remove what is in it first`);
				db.move(g, null);
			});
			return { path };
		});
	}

	// ---------------------------------------------------------------- internals

	/** Open Requests whose entry still exists outside the Recycle Bin with no password. */
	private requests(db: Kdbx): Map<string, Request> {
		const open = this.audit.openRequests();
		if (!open.size) return open;
		const live = new Map<string, Request>();
		for (const { entry, path } of allEntries(db)) {
			const r = open.get(path);
			if (r && !inRecycleBin(db, entry) && !fieldText(entry, 'Password')) live.set(path, r);
		}
		return live;
	}

	private summary(
		db: Kdbx,
		e: KdbxEntry,
		path: string,
		requests: Map<string, Request>
	): EntrySummary {
		const request = requests.get(path);
		const recycled = inRecycleBin(db, e);
		return {
			uuid: e.uuid.id,
			path,
			group: e.parentGroup ? groupPath(db, e.parentGroup) : '',
			title: fieldText(e, 'Title'),
			username: fieldText(e, 'UserName'),
			url: fieldText(e, 'URL'),
			set: {
				Password: !!fieldText(e, 'Password'),
				UserName: !!fieldText(e, 'UserName'),
				URL: !!fieldText(e, 'URL'),
				Notes: !!fieldText(e, 'Notes')
			},
			reference: recycled ? null : referenceFor(e.uuid.id),
			reference_problem: recycled ? 'It is in the Recycle Bin.' : null,
			recycled,
			from: recycled ? this.previousGroup(db, e) : null,
			request: request ? { actor: request.actor, at: request.at, reason: request.reason } : null,
			modified: e.times.lastModTime?.toISOString() ?? null
		};
	}

	private previousGroup(db: Kdbx, e: KdbxEntry): string | null {
		const uuid = e.previousParentGroup;
		const g = uuid ? db.getGroup(uuid) : undefined;
		return g && !inRecycleBin(db, g) ? groupPath(db, g) : null;
	}

	/** A group a person may rename, move or delete: not the root, not the Recycle Bin. */
	private ownGroup(db: Kdbx, path: string) {
		if (!path) reject('invalid_input', 'The top level is not a group');
		const g = groupAt(db, path);
		if (g === recycleBinOf(db)) reject('invalid_input', 'The Recycle Bin cannot be changed');
		return g;
	}

	/** The group at `path`, creating any missing part (store and request name new groups freely). */
	private ensureGroup(db: Kdbx, path: string) {
		let g = rootOf(db);
		const bin = recycleBinOf(db);
		for (const name of path ? path.split('/') : []) {
			const n = checkName(name, 'Group name');
			const next = g.groups.find((s) => s.name === n);
			if (next === bin && bin)
				reject('invalid_input', 'Entries cannot be created in the Recycle Bin');
			g = next ?? db.createGroup(g, n);
		}
		return g;
	}

	/**
	 * Run one operation and record it (spec §8): ok, rejected, not_found or failed. A repeated
	 * idempotency key returns the first result without doing it again (spec §10).
	 *
	 * An agent's change is strict: its History row is written before the change is released, still
	 * holding the lock, and if that row cannot be written the saved change is undone. A person's
	 * change is recorded best effort afterwards (a full disk must not undo what they did).
	 */
	private async attempt(
		actor: Actor,
		action: string,
		path: string,
		key: string | undefined,
		run: (commit: Commit) => Promise<Done>
	): Promise<Result> {
		if (key) {
			const done = this.audit.replayed(key);
			if (done)
				return {
					outcome: 'committed',
					path: (done.detail?.to as string) ?? done.path ?? path,
					reference: (done.detail?.reference as string | null) ?? null,
					replayed: true
				};
		}
		const at = this.now().toISOString();
		const strict = actor.startsWith('agent:');
		let sealed = false;
		const row = (r: Done) => ({
			at,
			actor,
			action,
			path,
			outcome: 'ok' as const,
			detail: {
				...r.detail,
				reference: r.reference ?? null,
				...(r.entry ? { entry: r.entry } : {})
			},
			key
		});
		const commit: Commit = (fn) =>
			this.vault.change(
				fn,
				strict
					? (r) => {
							try {
								this.audit.record(row(r));
							} catch {
								throw new AuditUnavailable();
							}
							sealed = true;
						}
					: undefined
			);
		try {
			const r = await run(commit);
			if (!sealed) this.log(row(r));
			return { outcome: 'committed', path: r.path, reference: r.reference ?? null };
		} catch (error) {
			if (error instanceof Rejection) {
				const outcome: AuditOutcome = error.code === 'not_found' ? 'not_found' : 'rejected';
				this.log({ at, actor, action, path, outcome, detail: { code: error.code } });
				return { outcome: 'rejected', code: error.code, reason: error.message };
			}
			this.log({ at, actor, action, path, outcome: 'failed', detail: { code: errorName(error) } });
			if (error instanceof AuditUnavailable)
				return {
					outcome: 'rejected',
					code: 'unavailable',
					reason: 'Falcon Vault could not record this change in History, so it was not made'
				};
			throw error;
		}
	}

	/** Audit is best effort for the caller: a full disk must not undo a committed change. */
	private log(e: Parameters<Audit['record']>[0]) {
		try {
			this.audit.record(e);
		} catch {
			/* the change stands; history misses one row */
		}
	}
}

type Done = {
	path: string;
	reference?: string | null;
	detail?: Record<string, unknown>;
	/** The entry's UUID, so its History follows it through renames and moves. */
	entry?: string;
};
type Commit = <T extends Done>(fn: (db: Kdbx) => T) => Promise<T>;

class AuditUnavailable extends Error {}

const STANDARD = ['Title', 'UserName', 'Password', 'URL', 'Notes'] as const;

/**
 * Keep the entry as it is now as a previous version (KeePassXC's entry history), then trim to the
 * database's limit: Maximum history items, 10 when unset, none when -1, as KeePassXC does.
 */
function keepVersion(db: Kdbx, e: KdbxEntry) {
	e.pushHistory();
	const max = db.meta.historyMaxItems;
	const limit = max === undefined ? 10 : max;
	if (limit >= 0 && e.history.length > limit) e.removeHistory(0, e.history.length - limit);
}

/** An entry's previous versions for a person, newest first: what each held, never a value. */
export function versionsOf(e: KdbxEntry) {
	const all = e.history;
	return all
		.map((v, version) => {
			const next = all[version + 1] ?? e;
			return {
				version,
				modified: v.times.lastModTime?.toISOString() ?? null,
				title: fieldText(v, 'Title'),
				username: fieldText(v, 'UserName'),
				url: fieldText(v, 'URL'),
				set: {
					Password: !!fieldText(v, 'Password'),
					UserName: !!fieldText(v, 'UserName'),
					URL: !!fieldText(v, 'URL'),
					Notes: !!fieldText(v, 'Notes')
				},
				/** What the next change after this version altered. */
				changed: STANDARD.filter((n) => fieldText(v, n) !== fieldText(next, n))
			};
		})
		.reverse();
}

const setNames = (f: EntryFields) =>
	(
		[
			['UserName', f.username],
			['Password', f.password],
			['URL', f.url],
			['Notes', f.notes]
		] as const
	)
		.filter(([, v]) => v)
		.map(([k]) => k);

/** An error's kind for audit, never its message (which could quote a value). */
const errorName = (e: unknown) =>
	(e as { code?: string })?.code ?? (e as Error)?.constructor?.name ?? 'Error';

export type { Event, Usage };
