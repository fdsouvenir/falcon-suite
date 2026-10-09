// The storage promises (spec §3, §4, §8): adopt untouched, create only when absent, refuse a half
// state, save atomically, respect outside edits, Recycle Bin, path identity, immutable audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kdbxweb } from '../dist/store/kdbx.js';
import { Vault, VaultUnavailable } from '../dist/store/vault.js';
import { replaceFile } from '../dist/store/files.js';
import {
	addEntries,
	externalDatabase,
	FRED,
	onDisk,
	openOps,
	openOutside,
	tempState,
	VERL
} from './helpers.mjs';

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const ok = (r) => {
	assert.equal(r.outcome, 'committed', JSON.stringify(r));
	return r;
};

test('an existing database is adopted untouched: reading writes nothing', async () => {
	const dir = tempState();
	await externalDatabase(dir, [
		['Providers', 'google-gemini', { Password: 'g-secret', UserName: 'me' }],
		['', 'Home-Assistant', { Password: 'ha' }]
	]);
	const db = join(dir, 'passwords.kdbx');
	const before = { hash: sha(db), mtime: statSync(db).mtimeMs, key: sha(join(dir, 'vault.key')) };
	const ops = await openOps(dir);
	assert.equal((await ops.overview()).total, 2);
	await ops.list({});
	await ops.entry('Providers/google-gemini', undefined, {}, 'falcon-vault');
	await ops.reveal(FRED, { path: 'Home-Assistant' }, 'Password', 'reveal');
	assert.equal(sha(db), before.hash);
	assert.equal(statSync(db).mtimeMs, before.mtime);
	assert.equal(sha(join(dir, 'vault.key')), before.key);
	// It is still the outside program's database: AES-KDF, as it was made.
	const outside = await openOutside(dir);
	assert.equal(outside.header.kdfParameters.get('R') !== undefined, true);
});

test('with neither file, both are created: KDBX 4, Argon2id, Recycle Bin on', async () => {
	const dir = tempState();
	await openOps(dir);
	const db = await openOutside(dir);
	assert.equal(db.versionMajor, 4);
	const uuid = new Uint8Array(db.header.kdfParameters.get('$UUID'));
	assert.deepEqual(
		uuid,
		new Uint8Array(kdbxweb.ByteUtils.base64ToBytes(kdbxweb.Consts.KdfId.Argon2id))
	);
	assert.equal(db.meta.recycleBinEnabled, true);
	assert.equal(statSync(join(dir, 'passwords.kdbx')).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, 'vault.key')).mode & 0o777, 0o600);
	assert.match(readFileSync(join(dir, 'vault.key'), 'utf8'), /<KeyFile>/);
});

test('a database without its key, or a key without its database, is refused and nothing is made', async () => {
	for (const keep of ['passwords.kdbx', 'vault.key']) {
		const dir = tempState();
		await externalDatabase(dir);
		const other = keep === 'passwords.kdbx' ? 'vault.key' : 'passwords.kdbx';
		const kept = sha(join(dir, keep));
		unlinkSync(join(dir, other));
		await assert.rejects(
			new Vault(dir).open(),
			(e) => e instanceof VaultUnavailable && /missing/.test(e.message)
		);
		assert.equal(existsSync(join(dir, other)), false, `${other} must not be created`);
		assert.equal(sha(join(dir, keep)), kept, `${keep} must be untouched`);
	}
});

test('a wrong key file makes the Vault unavailable, not empty', async () => {
	const dir = tempState();
	await externalDatabase(dir);
	writeFileSync(
		join(dir, 'vault.key'),
		new Uint8Array(await kdbxweb.Credentials.createRandomKeyFile(2))
	);
	await assert.rejects(new Vault(dir).open(), VaultUnavailable);
});

test('a change is saved by replacing the file; a rejected or failed change leaves it untouched', async () => {
	const dir = tempState();
	await externalDatabase(dir, [['A', 'one', { Password: 'p1' }]]);
	const file = join(dir, 'passwords.kdbx');
	const ops = await openOps(dir);
	const inode = statSync(file).ino;
	ok(await ops.create(FRED, { group: 'A', title: 'two', password: 'p2' }));
	assert.notEqual(statSync(file).ino, inode, 'renamed over, not written in place');
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(
		readdirSync(dir).filter((f) => f.endsWith('.tmp')),
		[],
		'no temporary file left behind'
	);
	const saved = sha(file);
	const r = await ops.create(FRED, { group: 'A', title: 'two', password: 'other' });
	assert.equal(r.code, 'exists');
	assert.equal(sha(file), saved);
	// A change whose save fails part-way never reaches the file.
	await assert.rejects(
		ops.vault.change(() => {
			throw new Error('boom');
		})
	);
	assert.equal(sha(file), saved);
	assert.equal((await onDisk(dir))['A/two'].Password, 'p2');
});

test('replaceFile leaves the original when the rename cannot happen', () => {
	const dir = tempState();
	const target = join(dir, 'sub');
	mkdirSync(target);
	writeFileSync(join(target, 'x'), 'keep');
	assert.throws(() => replaceFile(target, new Uint8Array([1, 2, 3])));
	assert.equal(readFileSync(join(target, 'x'), 'utf8'), 'keep');
	assert.deepEqual(
		readdirSync(dir).filter((f) => f.endsWith('.tmp')),
		[]
	);
});

test('an outside edit is picked up, and a save never overwrites one', async () => {
	const dir = tempState();
	await externalDatabase(dir, [['', 'first', { Password: 'a' }]]);
	const ops = await openOps(dir);
	assert.equal((await ops.overview()).total, 1);

	// KeePassXC desktop adds an entry while the Vault has the file loaded.
	const outside = await openOutside(dir);
	addEntries(outside, [['', 'from-desktop', { Password: 'd' }]]);
	writeFileSync(join(dir, 'passwords.kdbx'), new Uint8Array(await outside.save()));
	assert.deepEqual(
		(await ops.list({})).map((e) => e.path),
		['first', 'from-desktop']
	);

	// And again, this time landing between the Vault applying a change and saving it.
	const again = await openOutside(dir);
	addEntries(again, [['', 'racing', { Password: 'r' }]]);
	const racing = new Uint8Array(await again.save());
	let runs = 0;
	await ops.vault.change((db) => {
		if (runs++ === 0) writeFileSync(join(dir, 'passwords.kdbx'), racing);
		addEntries(db, [['', 'mine', { Password: 'm' }]]);
	});
	assert.equal(runs, 2, 'reloaded and applied again');
	assert.deepEqual(Object.keys(await onDisk(dir)).sort(), [
		'first',
		'from-desktop',
		'mine',
		'racing'
	]);
});

test('removing goes to the Recycle Bin; Delete forever only from there', async () => {
	const dir = tempState();
	await externalDatabase(dir, [['Services', 'stripe', { Password: 's' }]]);
	const ops = await openOps(dir);
	assert.equal(
		(await ops.deleteForever(FRED, { path: 'Services/stripe' })).code,
		'invalid_input',
		'not from outside the Recycle Bin'
	);
	ok(await ops.recycle(FRED, { path: 'Services/stripe' }));
	assert.deepEqual(Object.keys(await onDisk(dir)), ['Recycle Bin/stripe']);
	const bin = await ops.list({ scope: 'recycle' });
	assert.deepEqual(
		bin.map((e) => [e.path, e.recycled, e.reference]),
		[['Recycle Bin/stripe', true, null]]
	);
	assert.equal((await ops.overview()).total, 0);
	// Undo is a move back.
	ok(await ops.update(FRED, { path: 'Recycle Bin/stripe' }, { group: 'Services' }));
	ok(await ops.recycle(FRED, { path: 'Services/stripe' }));
	ok(await ops.deleteForever(FRED, { path: 'Recycle Bin/stripe' }));
	assert.deepEqual(await onDisk(dir), {});
});

test('identity is the exact path: never a title search, and a shared path is not guessed', async () => {
	const dir = tempState();
	await externalDatabase(dir, [
		['A', 'token', { Password: 'a' }],
		['B', 'token', { Password: 'b' }],
		['C', 'dup', { Password: 'c1' }],
		['C', 'dup', { Password: 'c2' }]
	]);
	const ops = await openOps(dir);
	assert.equal((await ops.reveal(FRED, { path: 'token' }, 'Password', 'reveal')).code, 'not_found');
	assert.equal((await ops.reveal(FRED, { path: 'B/token' }, 'Password', 'reveal')).value, 'b');
	assert.equal((await ops.reveal(FRED, { path: 'C/dup' }, 'Password', 'reveal')).code, 'ambiguous');
	const [first] = await ops.list({ group: 'C' });
	const picked = await ops.reveal(FRED, { path: 'C/dup', uuid: first.uuid }, 'Password', 'reveal');
	assert.ok(['c1', 'c2'].includes(picked.value));
	// A renamed entry is a different path; the old one is gone.
	ok(await ops.update(FRED, { path: 'A/token' }, { title: 'token-2' }));
	assert.equal(
		(await ops.reveal(FRED, { path: 'A/token' }, 'Password', 'reveal')).code,
		'not_found'
	);
	assert.equal((await ops.reveal(FRED, { path: 'A/token-2' }, 'Password', 'reveal')).value, 'a');
	assert.equal(
		(await ops.update(FRED, { path: 'A/token-2' }, { group: 'B', title: 'token' })).code,
		'exists'
	);
});

test('groups: create, rename in one write, move, and delete only when empty', async () => {
	const dir = tempState();
	await externalDatabase(dir, [['Services/Cloudflare', 'api', { Password: 'x' }]]);
	const ops = await openOps(dir);
	ok(await ops.createGroup(FRED, 'Services', 'Google'));
	assert.equal((await ops.createGroup(FRED, 'Services', 'Google')).code, 'exists');
	ok(await ops.renameGroup(FRED, 'Services/Cloudflare', 'CF'));
	assert.deepEqual(Object.keys(await onDisk(dir)), ['Services/CF/api']);
	assert.equal((await ops.deleteGroup(FRED, 'Services/CF')).code, 'not_empty');
	ok(await ops.moveGroup(FRED, 'Services/CF', ''));
	assert.deepEqual(Object.keys(await onDisk(dir)), ['CF/api']);
	assert.equal((await ops.moveGroup(FRED, 'Services', 'Services/Google')).code, 'invalid_input');
	ok(await ops.deleteGroup(FRED, 'Services/Google'));
	assert.equal((await ops.deleteGroup(FRED, 'Recycle Bin')).code, 'invalid_input');
	const tree = await ops.overview();
	assert.deepEqual(
		tree.groups.map((g) => [g.path, g.count]),
		[
			['Services', 0],
			['CF', 1]
		]
	);
});

test('store is create-only; request asks for a value; filling it closes the Request', async () => {
	const dir = tempState();
	const ops = await openOps(dir);
	ok(
		await ops.create(
			VERL,
			{ group: 'Services', title: 'resend', password: 'r1' },
			{ action: 'store' }
		)
	);
	const again = await ops.create(
		VERL,
		{ group: 'Services', title: 'resend', password: 'r2' },
		{ action: 'store' }
	);
	assert.equal(again.code, 'exists');
	assert.equal((await onDisk(dir))['Services/resend'].Password, 'r1', 'never overwritten');

	ok(
		await ops.request(VERL, {
			group: 'Services',
			title: 'stripe',
			username: 'reader',
			reason: 'payouts',
			session: 'agent:verl:main'
		})
	);
	assert.equal(
		(await ops.request(VERL, { group: 'Services', title: 'stripe', reason: 'again' })).code,
		'exists'
	);
	assert.equal((await ops.overview()).needs, 1);
	const [req] = await ops.list({ scope: 'needs' });
	assert.equal(req.request.reason, 'payouts');
	assert.equal(req.set.Password, false);
	const { result, request } = await ops.fill(FRED, { path: 'Services/stripe' }, 'sk_live');
	ok(result);
	assert.equal(request.session, 'agent:verl:main');
	assert.equal((await ops.overview()).needs, 0);
	assert.equal((await ops.fill(FRED, { path: 'Services/stripe' }, 'x')).result.code, 'not_found');

	ok(await ops.request(VERL, { title: 'github', reason: 'deploys' }));
	ok((await ops.dismiss(FRED, { path: 'github' })).result);
	assert.equal((await ops.overview()).needs, 0);
	assert.ok((await onDisk(dir))['Recycle Bin/github']);
});

test('an idempotency key makes a retried create a no-op', async () => {
	const dir = tempState();
	const ops = await openOps(dir);
	ok(await ops.create(VERL, { title: 'once', password: 'p' }, { key: 'tool:call-1' }));
	const retry = ok(
		await ops.create(VERL, { title: 'once', password: 'p' }, { key: 'tool:call-1' })
	);
	assert.equal(retry.replayed, true);
	assert.equal((await ops.overview()).total, 1);
});

test('audit history is append-only and never holds a value', async () => {
	const dir = tempState();
	const ops = await openOps(dir);
	ok(
		await ops.create(
			VERL,
			{ title: 'k', username: 'u', password: 'hunter2-SECRET', notes: 'note-SECRET' },
			{ action: 'store' }
		)
	);
	await ops.reveal(FRED, { path: 'k' }, 'Password', 'reveal');
	await ops.update(FRED, { path: 'k' }, { password: 'rotated-SECRET' });
	await ops.reveal(FRED, { path: 'missing' }, 'Password', 'copy');
	const events = ops.history({});
	assert.deepEqual(
		events.map((e) => [e.actor, e.action, e.outcome]),
		[
			[FRED, 'copy', 'not_found'],
			[FRED, 'edit_entry', 'ok'],
			[FRED, 'reveal', 'ok'],
			[VERL, 'store', 'ok']
		]
	);
	const db = new DatabaseSync(join(dir, 'falcon-vault', 'audit.db'));
	assert.throws(() => db.exec("UPDATE events SET actor = 'person:x'"), /append-only/);
	assert.throws(() => db.exec('DELETE FROM events'), /append-only/);
	assert.throws(
		() =>
			db.exec("INSERT INTO events (at, actor, action, outcome) VALUES ('t', 'someone', 'x', 'ok')"),
		/CHECK/
	);
	const strict = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get().sql;
	assert.match(strict, /STRICT/);
	db.close();
	for (const f of readdirSync(join(dir, 'falcon-vault')).filter((f) => f.startsWith('audit.db')))
		assert.doesNotMatch(readFileSync(join(dir, 'falcon-vault', f), 'latin1'), /SECRET/);
});

test('entries whose paths have spaces have no Reference, and say why', async () => {
	const dir = tempState();
	await externalDatabase(dir, [['Services/Home Assistant', 'token', { Password: 'x' }]]);
	const ops = await openOps(dir);
	const [e] = await ops.list({});
	assert.equal(e.reference, null);
	assert.match(e.reference_problem, /a space/);
});
