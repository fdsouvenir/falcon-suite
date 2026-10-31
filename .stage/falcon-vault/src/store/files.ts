import { createHash, randomBytes } from 'node:crypto';
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import path from 'node:path';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Identity of a file on disk, cheap to compare: inode, size and modification time. */
export function fileStamp(file: string): string | null {
	const s = statSync(file, { bigint: true, throwIfNoEntry: false });
	return s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
}

/** A regular file (not a symlink, device or folder), or absent. */
export function regularOrAbsent(file: string): boolean {
	const s = lstatSync(file, { throwIfNoEntry: false });
	if (!s) return false;
	if (!s.isFile() || s.isSymbolicLink())
		throw new Error(`${path.basename(file)} is not a regular file`);
	return true;
}

function fsyncDir(dir: string) {
	const fd = openSync(dir, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** A private temporary file beside `file`, holding `bytes`, flushed to disk. */
function writeTemp(file: string, bytes: Uint8Array): string {
	const temp = path.join(
		path.dirname(file),
		`.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
	);
	const fd = openSync(temp, 'wx', 0o600);
	try {
		let done = 0;
		while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkSync(temp);
		throw error;
	}
	closeSync(fd);
	return temp;
}

/**
 * Replace `file` with `bytes` (spec §3): a private temporary file, fsynced, renamed over the
 * original, then the directory fsynced. A failure at any step leaves the original untouched.
 */
export function replaceFile(file: string, bytes: Uint8Array) {
	const temp = writeTemp(file, bytes);
	try {
		renameSync(temp, file);
	} catch (error) {
		unlinkSync(temp);
		throw error;
	}
	fsyncDir(path.dirname(file));
}

/** Create `file` with `bytes`, failing if it exists: never overwrites (spec §3, provisioning). */
export function createFile(file: string, bytes: Uint8Array) {
	const temp = writeTemp(file, bytes);
	try {
		linkSync(temp, file); // EEXIST if anything is already there
	} finally {
		unlinkSync(temp);
	}
	fsyncDir(path.dirname(file));
}
