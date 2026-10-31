// Shared test fixtures. Every test works in its own private temp directory; nothing here touches
// a real Gateway state directory.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kdbxweb } from '../dist/store/kdbx.js';
import { Vault } from '../dist/store/vault.js';
import { Audit } from '../dist/store/audit.js';
import { VaultOps } from '../dist/store/ops.js';

const made = [];
process.on('exit', () => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A private temporary state directory, removed when the test process exits. */
export const tempState = () => {
	const dir = mkdtempSync(join(tmpdir(), 'falcon-vault-test-'));
	chmodSync(dir, 0o700);
	made.push(dir);
	return dir;
};

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/**
 * A database made the way KeePassXC (or Falcon Dash 4.x) made Verl's: KDBX 4, AES-KDF, key file
 * only, Recycle Bin on. `entries` are `[groupPath, title, { UserName, Password, URL, Notes }]`.
 */
export async function externalDatabase(dir, entries = []) {
	const key = new Uint8Array(await kdbxweb.Credentials.createRandomKeyFile(2));
	const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(null, ab(key)), 'Passwords');
	db.setKdf(kdbxweb.Consts.KdfId.Aes);
	db.header.kdfParameters.set(
		'R',
		kdbxweb.VarDictionary.ValueType.UInt64,
		kdbxweb.Int64.from(1000)
	);
	addEntries(db, entries);
	writeFileSync(join(dir, 'vault.key'), key, { mode: 0o600 });
	writeFileSync(join(dir, 'passwords.kdbx'), new Uint8Array(await db.save()), { mode: 0o600 });
	return { key };
}

export function addEntries(db, entries) {
	for (const [group, title, fields = {}] of entries) {
		let g = db.getDefaultGroup();
		for (const name of group ? group.split('/') : [])
			g = g.groups.find((x) => x.name === name) ?? db.createGroup(g, name);
		const e = db.createEntry(g);
		e.fields.set('Title', title);
		for (const [k, v] of Object.entries(fields))
			e.fields.set(k, k === 'Password' ? kdbxweb.ProtectedValue.fromString(v) : v);
	}
}

/** Load the database on disk the way an outside program (KeePassXC desktop) would. */
export async function openOutside(dir) {
	return kdbxweb.Kdbx.load(
		ab(new Uint8Array(readFileSync(join(dir, 'passwords.kdbx')))),
		new kdbxweb.Credentials(null, ab(new Uint8Array(readFileSync(join(dir, 'vault.key')))))
	);
}

/** Every entry on disk as `path → { field: value }`, read the outside way. */
export async function onDisk(dir) {
	const db = await openOutside(dir);
	const root = db.getDefaultGroup();
	const out = {};
	const walk = (g, prefix) => {
		for (const e of g.entries) {
			const fields = {};
			for (const [k, v] of e.fields) fields[k] = typeof v === 'string' ? v : v.getText();
			out[prefix + fields.Title] = fields;
		}
		for (const s of g.groups) walk(s, `${prefix}${s.name}/`);
	};
	walk(root, '');
	return out;
}

export async function openOps(dir) {
	const vault = new Vault(dir);
	await vault.open();
	return new VaultOps(vault, new Audit(join(dir, 'falcon-vault', 'audit.db')));
}

export const FRED = 'person:fred';
export const VERL = 'agent:verl';
