import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Audit history (spec §8): `<state>/falcon-vault/audit.db`, append-only and STRICT. Triggers reject
 * updates and deletes. One Event per operation attempt and its outcome. No values, ever: `detail`
 * holds only names (which fields changed, where an entry moved, why an agent asked).
 */
const SCHEMA = `
CREATE TABLE events (
	id INTEGER PRIMARY KEY,
	at TEXT NOT NULL,
	actor TEXT NOT NULL CHECK (actor = 'resolver' OR actor GLOB 'person:?*' OR actor GLOB 'agent:?*'),
	action TEXT NOT NULL,
	path TEXT,
	outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'not_found', 'failed')),
	detail TEXT,
	idempotency_key TEXT
) STRICT;
CREATE INDEX events_path ON events (path, id);
CREATE INDEX events_actor ON events (actor, id);
CREATE INDEX events_key ON events (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
	BEGIN SELECT RAISE(ABORT, 'Falcon Vault audit history is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
	BEGIN SELECT RAISE(ABORT, 'Falcon Vault audit history is append-only'); END;
`;
const SCHEMA_VERSION = 1;

export type Outcome = 'ok' | 'rejected' | 'not_found' | 'failed';
export type Event = {
	id: number;
	at: string;
	actor: string;
	action: string;
	path: string | null;
	outcome: Outcome;
	detail: Record<string, unknown> | null;
};
/** An agent's open Request (spec §7): who asked, when, why, and the session to tell. */
export type Request = {
	path: string;
	actor: string;
	at: string;
	reason: string;
	session: string | null;
};

export class Audit {
	readonly db: DatabaseSync;

	constructor(file: string) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const stat = lstatSync(file, { throwIfNoEntry: false });
		if (stat && (!stat.isFile() || stat.isSymbolicLink()))
			throw new Error('Falcon Vault audit path is not a regular file');
		this.db = new DatabaseSync(file);
		chmodSync(file, 0o600);
		// The resolver writes from its own process, so WAL with a busy timeout.
		this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
		const version = Number(
			(this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
		);
		if (version === 0) {
			this.db.exec('BEGIN IMMEDIATE');
			try {
				// Another process may have created it while we waited for the write lock.
				const again = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
					.user_version;
				if (!again) {
					this.db.exec(SCHEMA);
					this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
				}
				this.db.exec('COMMIT');
			} catch (error) {
				this.db.exec('ROLLBACK');
				throw error;
			}
		} else if (version !== SCHEMA_VERSION)
			throw new Error(`Unsupported Falcon Vault audit schema version ${version}`);
	}

	record(e: {
		actor: string;
		action: string;
		path?: string | null;
		outcome: Outcome;
		detail?: Record<string, unknown> | null;
		key?: string | null;
		at?: string;
	}) {
		this.db
			.prepare(
				'INSERT INTO events (at, actor, action, path, outcome, detail, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				e.at ?? new Date().toISOString(),
				e.actor,
				e.action,
				e.path ?? null,
				e.outcome,
				e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : null,
				e.key ?? null
			);
	}

	/** The successful write an idempotency key already made, if any. */
	replayed(key: string): Event | null {
		const row = this.db
			.prepare(
				"SELECT * FROM events WHERE idempotency_key = ? AND outcome = 'ok' ORDER BY id LIMIT 1"
			)
			.get(key) as Row | undefined;
		return row ? event(row) : null;
	}

	/** Newest first, filtered by path, actor or action. */
	history(
		f: { path?: string; actor?: string; action?: string; before?: number; limit?: number } = {}
	) {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (f.path) (where.push('path = ?'), args.push(f.path));
		if (f.actor) (where.push('actor = ?'), args.push(f.actor));
		if (f.action) (where.push('action = ?'), args.push(f.action));
		if (f.before) (where.push('id < ?'), args.push(f.before));
		const rows = this.db
			.prepare(
				`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
			)
			.all(...args, Math.min(f.limit ?? 50, 500)) as Row[];
		return rows.map(event);
	}

	/**
	 * Requests not yet filled or dismissed, by path. Whether the entry still exists and still has
	 * no password is for the caller to check against the database.
	 */
	openRequests(): Map<string, Request> {
		const rows = this.db
			.prepare(
				`SELECT * FROM events WHERE outcome = 'ok' AND action IN ('request', 'fill_request', 'dismiss_request', 'store', 'create_entry') ORDER BY id`
			)
			.all() as Row[];
		const open = new Map<string, Request>();
		for (const r of rows) {
			if (!r.path) continue;
			if (r.action === 'request') {
				const d = (r.detail ? JSON.parse(r.detail) : {}) as { reason?: string; session?: string };
				open.set(r.path, {
					path: r.path,
					actor: r.actor,
					at: r.at,
					reason: d.reason ?? '',
					session: d.session ?? null
				});
			} else open.delete(r.path);
		}
		return open;
	}

	close() {
		this.db.close();
	}
}

type Row = {
	id: number;
	at: string;
	actor: string;
	action: string;
	path: string | null;
	outcome: Outcome;
	detail: string | null;
};
const event = (r: Row): Event => ({
	id: r.id,
	at: r.at,
	actor: r.actor,
	action: r.action,
	path: r.path,
	outcome: r.outcome,
	detail: r.detail ? JSON.parse(r.detail) : null
});
