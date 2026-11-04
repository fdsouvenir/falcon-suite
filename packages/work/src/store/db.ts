import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { SCHEMA, SCHEMA_VERSION } from './schema.js';

/**
 * A Work 5 database (schema version 1 or 2) is set aside as `<file>.before-2`, untouched, and
 * 2.0 starts clean (spec §8). Returns the path it was moved to, or null.
 */
export function setAsideWork5(file: string): string | null {
	if (file === ':memory:' || !existsSync(file)) return null;
	const db = new DatabaseSync(file);
	const version = Number(
		(db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
	);
	if (version !== 1 && version !== 2) {
		db.close();
		return null;
	}
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	db.close();
	let target = `${file}.before-2`;
	for (let n = 2; existsSync(target); n++) target = `${file}.before-2.${n}`;
	renameSync(file, target);
	for (const suffix of ['-wal', '-shm'])
		if (existsSync(file + suffix)) renameSync(file + suffix, target + suffix);
	return target;
}

/**
 * Open (or create) the private Work database. `:memory:` is accepted for tests.
 * The file and its sidecars are owner-only; a database written by anything other than this
 * schema version is refused rather than adopted.
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
