import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { SCHEMA, SCHEMA_VERSION } from './schema.js';

/**
 * Open (or create) the private Work database. `:memory:` is accepted for tests.
 * The file and its sidecars are owner-only; a database written by anything other than this
 * schema version is refused rather than adopted (Work 5 has no awareness of prior versions).
 */
export function openWorkDatabase(file: string): DatabaseSync {
	if (file !== ':memory:') {
		if (!isAbsolute(file)) throw new Error('Work database path must be absolute');
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const stat = lstatSync(file, { throwIfNoEntry: false });
		if (stat && (!stat.isFile() || stat.isSymbolicLink()))
			throw new Error('Work database path is not a regular file');
	}
	const db = new DatabaseSync(file);
	if (file !== ':memory:') chmodSync(file, 0o600);
	db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
	db.exec('PRAGMA foreign_keys=ON;');
	const version = Number(
		(db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
	);
	if (version === 0) {
		const tables = (
			db
				.prepare(
					"SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
				)
				.get() as { n: number }
		).n;
		if (tables !== 0) throw new Error('Refusing to adopt a database Work did not create');
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	} else if (version !== SCHEMA_VERSION) {
		throw new Error(`Unsupported Work database schema version ${version}`);
	}
	if (file !== ':memory:')
		for (const suffix of ['-wal', '-shm'])
			if (lstatSync(file + suffix, { throwIfNoEntry: false })) chmodSync(file + suffix, 0o600);
	return db;
}
