import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('provisioning preserves the Office key and delivers both CLI variables without printing it', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'link-provision-'));
	try {
		const dir = path.join(root, 'falcon-link'),
			config = path.join(root, 'openclaw.json'),
			input = path.join(root, 'input.json');
		const key = 'private-test-key-not-for-output';
		await mkdir(dir);
		await writeFile(
			config,
			JSON.stringify({ env: { vars: { FALCON_LINK_KEYRING_PASSWORD: key, UNRELATED: 'keep' } } })
		);
		await writeFile(input, '{}');
		await writeFile(
			path.join(root, 'openclaw'),
			`#!${process.execPath}
const fs=require('fs');const p=process.env.OPENCLAW_CONFIG_PATH,c=JSON.parse(fs.readFileSync(p));for(const entry of JSON.parse(fs.readFileSync(process.argv.at(-1)))){const keys=entry.path.split('.');let o=c;for(const k of keys.slice(0,-1))o=o[k]??={};o[keys.at(-1)]=entry.value;}fs.writeFileSync(p,JSON.stringify(c));`,
			{ mode: 0o700 }
		);
		const args = [fileURLToPath(new URL('../scripts/provision.mjs', import.meta.url)), dir, input];
		const env = {
			...process.env,
			OPENCLAW_CONFIG_PATH: config,
			PATH: root + path.delimiter + process.env.PATH
		};
		for (let i = 0; i < 2; i++) {
			const output = execFileSync(process.execPath, args, { env, encoding: 'utf8' });
			assert.ok(!output.includes(key));
			const c = JSON.parse(await readFile(config, 'utf8'));
			assert.equal(c.env.vars.GOG_KEYRING_PASSWORD, key);
			assert.equal(c.env.vars.M365CLI_KEYRING_PASSWORD, key);
			assert.equal(c.env.vars.FALCON_LINK_KEYRING_PASSWORD, key);
			assert.equal(c.env.vars.UNRELATED, 'keep');
			assert.equal(c.plugins.entries['falcon-link'].hooks.allowConversationAccess, true);
		}
		const conflict = JSON.parse(await readFile(config, 'utf8'));
		conflict.env.vars.GOG_KEYRING_PASSWORD = 'different-existing-key';
		await writeFile(config, JSON.stringify(conflict));
		assert.throws(() => execFileSync(process.execPath, args, { env, stdio: 'pipe' }));
		assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), conflict);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
