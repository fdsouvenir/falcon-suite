// The SecretRef resolver (spec §5, §12): exec-provider protocol v1 as OpenClaw runs it — a separate
// process with an empty environment, one request on stdin, one response on stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
	existsSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateStateDir } from '../dist/resolver.js';
import { externalDatabase, FRED, openOps, tempState } from './helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/resolve-secrets.mjs', import.meta.url));

/** Run the resolver as OpenClaw does: no shell, only the passed-on environment. */
function run(input, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('close', (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
	});
}
const request = (ids) => ({ protocolVersion: 1, provider: 'keepassxc', ids });

async function vault() {
	const dir = tempState();
	await externalDatabase(dir, [
		[
			'Providers',
			'google-gemini',
			{ Password: 'gem-SECRET', UserName: 'me@x', URL: 'https://ai', Notes: 'n' }
		],
		['Channels', 'telegram', { Password: 'tg-SECRET' }],
		['', 'Home-Assistant', { Password: 'ha-SECRET' }],
		['Services/Home Assistant', 'token', { Password: 'spaced-SECRET' }],
		['Dup', 'twice', { Password: 'one' }],
		['Dup', 'twice', { Password: 'two' }],
		['', 'empty', { Password: '' }]
	]);
	return dir;
}

test('resolves Path and Path:Field, with NOT_FOUND per id', async () => {
	const dir = await vault();
	const r = await run(
		request([
			'Providers/google-gemini',
			'Providers/google-gemini:UserName',
			'Providers/google-gemini:URL',
			'Providers/google-gemini:Title',
			'Channels/telegram:Password',
			'Home-Assistant',
			'Providers/nope',
			'google-gemini',
			'empty',
			'Dup/twice'
		]),
		{ OPENCLAW_STATE_DIR: dir }
	);
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stderr, '');
	const out = JSON.parse(r.stdout);
	assert.equal(out.protocolVersion, 1);
	assert.deepEqual(out.values, {
		'Providers/google-gemini': 'gem-SECRET',
		'Providers/google-gemini:UserName': 'me@x',
		'Providers/google-gemini:URL': 'https://ai',
		'Providers/google-gemini:Title': 'google-gemini',
		'Channels/telegram:Password': 'tg-SECRET',
		'Home-Assistant': 'ha-SECRET'
	});
	assert.deepEqual(out.errors, {
		'Providers/nope': { code: 'NOT_FOUND' },
		'google-gemini': { code: 'NOT_FOUND' }, // a title alone is never matched
		empty: { code: 'NOT_FOUND' },
		'Dup/twice': { code: 'AMBIGUOUS_DUPLICATE_KEY' }
	});
});

test('entries in the Recycle Bin and ids outside the grammar do not resolve', async () => {
	const dir = await vault();
	const ops = await openOps(dir);
	await ops.recycle(FRED, { path: 'Channels/telegram' });
	const r = await run(
		request(['Channels/telegram', 'Recycle Bin/telegram', 'Services/Home Assistant/token', '../x']),
		{ OPENCLAW_STATE_DIR: dir }
	);
	const out = JSON.parse(r.stdout);
	assert.deepEqual(out.values, {});
	assert.equal(Object.keys(out.errors).length, 4);
	assert.doesNotMatch(r.stdout, /SECRET/);
});

test('bounded input: at most 50 ids and 16 KiB, protocol version 1 only', async () => {
	const dir = await vault();
	const env = { OPENCLAW_STATE_DIR: dir };
	const many = await run(request(Array.from({ length: 51 }, (_, i) => `x${i}`)), env);
	assert.notEqual(many.code, 0);
	assert.equal(many.stdout, '');
	const fifty = await run(request(Array.from({ length: 50 }, (_, i) => `x${i}`)), env);
	assert.equal(fifty.code, 0);
	const big = await run(request(['a'.repeat(17_000)]), env);
	assert.notEqual(big.code, 0);
	assert.equal(big.stdout, '');
	const v2 = await run({ protocolVersion: 2, ids: ['Home-Assistant'] }, env);
	assert.notEqual(v2.code, 0);
	assert.equal(v2.stdout, '');
	const junk = await run('not json', env);
	assert.notEqual(junk.code, 0);
	assert.doesNotMatch(many.stderr + big.stderr + v2.stderr + junk.stderr, /SECRET/);
});

test('every id is one audit Event by the resolver, without values', async () => {
	const dir = await vault();
	await run(request(['Home-Assistant', 'Providers/nope']), { OPENCLAW_STATE_DIR: dir });
	const ops = await openOps(dir);
	const events = ops.history({ actor: 'resolver' });
	assert.deepEqual(events.map((e) => [e.action, e.path, e.outcome]).sort(), [
		['resolve', 'Home-Assistant', 'ok'],
		['resolve', 'Providers/nope', 'not_found']
	]);
	for (const f of readdirSync(join(dir, 'falcon-vault')).filter((f) => f.startsWith('audit.db')))
		assert.doesNotMatch(readFileSync(join(dir, 'falcon-vault', f), 'latin1'), /SECRET/);
});

test('the resolver waits for the lock, and breaks a lock its holder left behind', async () => {
	const dir = await vault();
	mkdirSync(join(dir, 'falcon-vault'), { recursive: true });
	const lock = join(dir, 'falcon-vault', 'vault.lock');
	// Held by a live process (this one): the resolver waits until it is released.
	writeFileSync(
		lock,
		JSON.stringify({
			pid: process.pid,
			host: (await import('node:os')).hostname(),
			at: Date.now(),
			token: 't'
		})
	);
	const started = Date.now();
	const pending = run(request(['Home-Assistant']), { OPENCLAW_STATE_DIR: dir });
	setTimeout(() => unlinkSync(lock), 400);
	const r = await pending;
	assert.equal(JSON.parse(r.stdout).values['Home-Assistant'], 'ha-SECRET');
	assert.ok(Date.now() - started >= 400, 'it waited');
	assert.equal(existsSync(lock), false, 'and released its own lock');
	// Held by a process that no longer exists: broken at once.
	writeFileSync(
		lock,
		JSON.stringify({
			pid: 2 ** 22 + 7,
			host: (await import('node:os')).hostname(),
			at: Date.now(),
			token: 't'
		})
	);
	const stale = await run(request(['Home-Assistant']), { OPENCLAW_STATE_DIR: dir });
	assert.equal(JSON.parse(stale.stdout).values['Home-Assistant'], 'ha-SECRET');
});

test('an unavailable Vault fails the run without creating anything', async () => {
	const dir = tempState();
	const r = await run(request(['x']), { OPENCLAW_STATE_DIR: dir });
	assert.notEqual(r.code, 0);
	assert.equal(r.stdout, '');
	assert.equal(existsSync(join(dir, 'passwords.kdbx')), false);
	assert.equal(existsSync(join(dir, 'vault.key')), false);
});

test('the state directory comes from OPENCLAW_STATE_DIR or the install location, never HOME', () => {
	assert.equal(locateStateDir({ OPENCLAW_STATE_DIR: '/srv/oc' }, '/anything/bin/r.mjs'), '/srv/oc');
	assert.equal(
		locateStateDir(
			{ HOME: '/home/x' },
			'/home/x/.openclaw/extensions/falcon-vault/bin/resolve-secrets.mjs'
		),
		'/home/x/.openclaw'
	);
	assert.equal(
		locateStateDir({}, '/var/oc/npm/node_modules/@fdsouvenir/falcon-vault/bin/resolve-secrets.mjs'),
		'/var/oc'
	);
	assert.equal(
		locateStateDir({ HOME: '/home/x' }, '/repo/packages/vault/bin/resolve-secrets.mjs'),
		null
	);
});
