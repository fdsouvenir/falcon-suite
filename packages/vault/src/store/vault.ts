import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createFile, fileStamp, regularOrAbsent, replaceFile, sha256 } from './files.js';
import { loadDatabase, newDatabase, saveDatabase, type Kdbx } from './kdbx.js';
import { withLock } from './lock.js';
import { Rejection } from './model.js';
import { DATA_DIR, DB_FILE, KEY_FILE, LOCK_FILE } from './paths.js';

/** Startup failed (spec §3): the Vault tab shows this reason instead of a list. */
export class VaultUnavailable extends Error {}

/**
 * The database file and its key (spec §3), kept loaded between operations.
 *
 * Every read and change holds the lock. Before using its loaded copy, the Vault checks that the
 * file on disk is still the one it loaded (KeePassXC desktop may have saved it) and reloads if not.
 * A change is applied, saved to bytes, and written over the file only if the file on disk is still
 * byte-for-byte the one it was applied to; otherwise the Vault reloads and applies it again, so an
 * outside edit is never overwritten.
 */
export class Vault {
	readonly dbFile: string;
	readonly keyFile: string;
	readonly lockFile: string;
	private db: Kdbx | null = null;
	private loadedHash: string | null = null;
	private loadedStamp: string | null = null;

	constructor(
		readonly stateDir: string,
		readonly lockTimeoutMs = 15_000
	) {
		if (!path.isAbsolute(stateDir))
			throw new VaultUnavailable('The state directory must be absolute');
		this.dbFile = path.join(stateDir, DB_FILE);
		this.keyFile = path.join(stateDir, KEY_FILE);
		this.lockFile = path.join(stateDir, DATA_DIR, LOCK_FILE);
	}

	/**
	 * Open the database, creating it and its key only when neither exists (spec §3, provisioning
	 * is invisible). An existing database is opened as it is; nothing is rewritten.
	 */
	open(options: { create?: boolean } = {}): Promise<void> {
		return this.exclusive(async () => {
			mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
			const hasDb = regularOrAbsent(this.dbFile);
			const hasKey = regularOrAbsent(this.keyFile);
			if (!hasDb && !hasKey && options.create !== false) {
				const { data, key } = await newDatabase();
				createFile(this.keyFile, key);
				createFile(this.dbFile, data);
			} else if (!hasDb || !hasKey)
				throw new VaultUnavailable(
					!hasDb && !hasKey
						? `There is no database at ${this.dbFile}`
						: hasDb
							? `${DB_FILE} exists but its key file ${KEY_FILE} is missing from ${this.stateDir}. Restore the key file; Vault will not create a new one beside an existing database.`
							: `${KEY_FILE} exists but ${DB_FILE} is missing from ${this.stateDir}. Restore the database; Vault will not create a new one for an existing key.`
				);
			await this.refresh();
		});
	}

	/** Run `fn` on the current database, holding the lock. */
	read<T>(fn: (db: Kdbx) => T | Promise<T>): Promise<T> {
		return this.exclusive(async () => {
			await this.refresh();
			return fn(this.db!);
		});
	}

	/**
	 * Apply `fn` and save. `fn` may run more than once (after an outside edit), so it must work
	 * from the database it is given. It should reject (throw a Rejection) before changing anything;
	 * any other failure drops the loaded copy so nothing half-applied survives.
	 */
	change<T>(fn: (db: Kdbx) => T): Promise<T> {
		return this.exclusive(async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				await this.refresh();
				let result: T;
				let bytes: Uint8Array;
				try {
					result = fn(this.db!);
					bytes = await saveDatabase(this.db!);
				} catch (error) {
					if (!(error instanceof Rejection)) this.forget();
					throw error;
				}
				// The file on disk must still be the one this change was applied to.
				if (sha256(this.readFile(this.dbFile)) !== this.loadedHash) {
					this.forget();
					continue;
				}
				replaceFile(this.dbFile, bytes);
				this.loadedHash = sha256(bytes);
				this.loadedStamp = fileStamp(this.dbFile);
				return result;
			}
			throw new Error('The database kept changing on disk while saving; try again');
		});
	}

	/** Drop the loaded copy; the next operation reads the file again. */
	forget() {
		this.db = null;
		this.loadedHash = null;
		this.loadedStamp = null;
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		return withLock(this.lockFile, fn, this.lockTimeoutMs);
	}

	private readFile(file: string): Uint8Array {
		if (!regularOrAbsent(file))
			throw new VaultUnavailable(`${path.basename(file)} is missing from ${this.stateDir}`);
		return readFileSync(file);
	}

	/** Reload when the file on disk is not the one loaded. */
	private async refresh() {
		const stamp = fileStamp(this.dbFile);
		if (this.db && stamp && stamp === this.loadedStamp) return;
		const data = this.readFile(this.dbFile);
		const hash = sha256(data);
		if (this.db && hash === this.loadedHash) {
			this.loadedStamp = stamp;
			return;
		}
		try {
			this.db = await loadDatabase(data, this.readFile(this.keyFile));
		} catch (error) {
			this.forget();
			const e = error as { code?: string; message?: string };
			throw new VaultUnavailable(
				e.code === 'InvalidKey'
					? `${KEY_FILE} does not open ${DB_FILE}`
					: `${DB_FILE} could not be opened: ${e.message ?? e}`
			);
		}
		this.loadedHash = hash;
		this.loadedStamp = stamp;
	}
}
