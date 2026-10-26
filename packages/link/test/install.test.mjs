import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install } from '../dist/install.js';
import { executable } from '../dist/cli.js';
import { execFileSync } from 'node:child_process';

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

// A UI install must produce a command usable by an ordinary agent shell, not only Link.
test('verified installation publishes a normal PATH binary without replacing unrelated tools', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'link-path-install-'));
	try {
		const bin = path.join(home, '.local', 'bin');
		await mkdir(bin, { recursive: true });
		await writeFile(path.join(home, 'gog'), '#!/bin/sh\necho v0.47.0\n', { mode: 0o755 });
		execFileSync('tar', ['-czf', path.join(home, 'release.tar.gz'), '-C', home, 'gog']);
		const script = `
   import fs from 'node:fs';
   import path from 'node:path';
   import {createHash} from 'node:crypto';
   import {execFileSync} from 'node:child_process';
   import {install} from ${JSON.stringify(new URL('../dist/install.js', import.meta.url).href)};
   import {executable} from ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)};
   const home=process.env.HOME, dir=path.join(home,'.openclaw','falcon-link');
   const archive=fs.readFileSync(path.join(home,'release.tar.gz'));
   const asset={name:'gogcli_0.47.0_linux_'+(process.arch==='x64'?'amd64':'arm64')+'.tar.gz',digest:'sha256:'+createHash('sha256').update(archive).digest('hex')};
   asset.browser_download_url='https://github.com/openclaw/gogcli/releases/download/v0.47.0/'+asset.name;
   globalThis.fetch=async url=>String(url).startsWith('https://api.github.com/')?Response.json({tag_name:'v0.47.0',assets:[asset]}):new Response(archive);
   await install(dir,'google');
   const selected=executable(dir,'google');
   if(selected!==path.join(home,'.local/bin/gog'))throw Error('Not a normal PATH binary: '+selected);
   if(!execFileSync('gog',['--version'],{encoding:'utf8'}).includes('0.47.0'))throw Error('Not shell accessible');
   fs.writeFileSync(selected,'#!/bin/sh\\necho unrelated\\n',{mode:0o755});
   let refused=false;try{await install(dir,'google')}catch{refused=true}
   if(!refused || !fs.readFileSync(selected,'utf8').includes('unrelated'))throw Error('Overwrote unrelated CLI');
  `;
		execFileSync(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH },
			stdio: 'pipe'
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
