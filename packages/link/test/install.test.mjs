import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install } from '../dist/install.js';
import { executable } from '../dist/cli.js';

test(
	'a corrupted upstream archive cannot replace the active CLI or touch account data',
	{ skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) },
	async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'link-update-'));
		const originalFetch = globalThis.fetch;
		try {
			const base = path.join(dir, 'tools', 'google');
			await mkdir(path.join(base, '0.46.0'), { recursive: true });
			const old = path.join(base, '0.46.0', 'gog');
			await writeFile(old, 'previous working CLI');
			await writeFile(path.join(base, 'current.json'), JSON.stringify({ version: '0.46.0' }));
			await writeFile(path.join(dir, 'accounts.json'), 'existing account data');
			globalThis.fetch = async (url) =>
				String(url).startsWith('https://api.github.com/')
					? Response.json({
							tag_name: 'v0.47.0',
							assets: [
								{
									name: `gogcli_0.47.0_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`,
									digest: `sha256:${'0'.repeat(64)}`,
									browser_download_url: `https://github.com/openclaw/gogcli/releases/download/v0.47.0/gogcli_0.47.0_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`
								}
							]
						})
					: new Response('corrupted download');
			await assert.rejects(() => install(dir, 'google'), /checksum mismatch/);
			assert.equal(executable(dir, 'google'), old);
			assert.equal(await readFile(old, 'utf8'), 'previous working CLI');
			assert.equal(
				await readFile(path.join(dir, 'accounts.json'), 'utf8'),
				'existing account data'
			);
		} finally {
			globalThis.fetch = originalFetch;
			await rm(dir, { recursive: true, force: true });
		}
	}
);
