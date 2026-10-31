import kdbxweb from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

/**
 * KDBX 4 through kdbxweb (spec §3, §10): pure JavaScript, with Argon2 from hash-wasm's
 * WebAssembly. No native modules and no host binaries.
 */
export { kdbxweb };
export type Kdbx = kdbxweb.Kdbx;
export type KdbxEntry = kdbxweb.KdbxEntry;
export type KdbxGroup = kdbxweb.KdbxGroup;

kdbxweb.CryptoEngine.setArgon2Impl(
	async (password, salt, memory, iterations, length, parallelism, type) => {
		const run = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
		const out = await run({
			password: new Uint8Array(password),
			salt: new Uint8Array(salt),
			memorySize: memory, // KiB
			iterations,
			parallelism,
			hashLength: length,
			outputType: 'binary'
		});
		return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
	}
);

const buffer = (bytes: Uint8Array) =>
	bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Open a database with its key file. There is no master password (spec §3). */
export const loadDatabase = (data: Uint8Array, key: Uint8Array): Promise<Kdbx> =>
	kdbxweb.Kdbx.load(buffer(data), new kdbxweb.Credentials(null, buffer(key)));

export const saveDatabase = async (db: Kdbx) => new Uint8Array(await db.save());

/**
 * A new database and its key file: KDBX 4, Argon2id (64 MiB, 3 passes, 2 lanes, about a quarter
 * second here), a KeePassXC 2.0 XML key file, and the Recycle Bin enabled.
 */
export async function newDatabase(): Promise<{ data: Uint8Array; key: Uint8Array }> {
	const key = new Uint8Array(await kdbxweb.Credentials.createRandomKeyFile(2));
	const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(null, buffer(key)), 'Passwords');
	db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
	const kdf = db.header.kdfParameters!;
	const { UInt32, UInt64 } = kdbxweb.VarDictionary.ValueType;
	kdf.set('M', UInt64, kdbxweb.Int64.from(64 * 1024 * 1024));
	kdf.set('I', UInt64, kdbxweb.Int64.from(3));
	kdf.set('P', UInt32, 2);
	db.createRecycleBin();
	return { data: await saveDatabase(db), key };
}

/** A field's text, whether it is stored protected or plain. */
export function fieldText(entry: KdbxEntry, name: string): string {
	const v = entry.fields.get(name);
	if (v === undefined) return '';
	return typeof v === 'string' ? v : v.getText();
}

/** Password is always stored protected, as KeePassXC does; the other standard fields plain. */
export function setField(entry: KdbxEntry, name: string, value: string) {
	entry.fields.set(name, name === 'Password' ? kdbxweb.ProtectedValue.fromString(value) : value);
}
