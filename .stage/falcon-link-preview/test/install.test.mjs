import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install } from '../dist/install.js';
import { executable } from '../dist/tools.js';
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
   import {executable} from ${JSON.stringify(new URL('../dist/tools.js', import.meta.url).href)};
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
   fs.unlinkSync(selected);
   if(executable(dir,'google').startsWith(dir+path.sep))throw Error('Uninstall fell back to private cache');
  `;
		execFileSync(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH },
			stdio: 'pipe'
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

// HubSpot's CLI replaces its own binary. Link must still recognize the one it installed and
// update it with the CLI's own upgrade, rather than call it foreign or download over it.
test(
	'a self-updating CLI stays Link-managed after it updates itself, and Update runs its own upgrade',
	{ skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) },
	async () => {
		const home = await mkdtemp(path.join(tmpdir(), 'link-vendor-install-'));
		try {
			const bin = path.join(home, '.local', 'bin');
			await mkdir(bin, { recursive: true });
			const build = (version) =>
				`#!/bin/sh\nif [ "$1" = upgrade ]; then echo x >> "$HOME/upgrades"; cp "$HOME/next" "$0"; exit 0; fi\necho "hubspot ${version} (build 1, commit fixture)"\n`;
			await writeFile(path.join(home, 'first'), build('0.16.0'));
			await writeFile(path.join(home, 'next'), build('0.17.0'));
			const script = `
   import fs from 'node:fs';
   import path from 'node:path';
   import assert from 'node:assert/strict';
   import {createHash} from 'node:crypto';
   import {execFileSync} from 'node:child_process';
   import {install} from ${JSON.stringify(new URL('../dist/install.js', import.meta.url).href)};
   import {overview} from ${JSON.stringify(new URL('../dist/status.js', import.meta.url).href)};
   const home=process.env.HOME, dir=path.join(home,'.openclaw','falcon-link'), command=path.join(home,'.local/bin/hubspot');
   const bytes=fs.readFileSync(path.join(home,'first'));
   let published='0'.repeat(64), downloads=0;
   globalThis.fetch=async url=>{ url=String(url); if(!url.startsWith('https://api.hubapi.com/'))return new Response('',{status:404}); if(url.endsWith('.sha256'))return new Response(published+'  hubspot.bin\\n'); downloads++; return new Response(bytes); };
   await assert.rejects(()=>install(dir,'hubspot'),/checksum mismatch/);
   assert.equal(fs.existsSync(command),false,'an unverified download is never installed');
   published=createHash('sha256').update(bytes).digest('hex');
   await install(dir,'hubspot');
   assert.match(execFileSync('hubspot',['--version'],{encoding:'utf8'}),/0.16.0/);
   execFileSync(command,['upgrade']);
   const hubspot=(await overview(dir)).integrations.find(i=>i.id==='hubspot');
   assert.equal(hubspot.tool.version,'0.17.0'); assert.equal(hubspot.managed,true,'its own update does not make it foreign');
   const before=downloads; await install(dir,'hubspot');
   assert.equal(downloads,before,'Update uses the CLI upgrade, not a download over it');
   assert.equal(fs.readFileSync(path.join(home,'upgrades'),'utf8').trim().split('\\n').length,2);
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'tools/hubspot/path-install.json'))).version,'0.17.0');
  `;
			execFileSync(process.execPath, ['--input-type=module', '-e', script], {
				env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH },
				stdio: 'pipe'
			});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
);

// dbxcli releases keep the binary in a folder named after the archive and publish SHA256SUMS,
// which must list the archive with the digest Link downloaded.
test(
	'dbxcli installs from its release folder only when SHA256SUMS lists the same archive',
	{ skip: process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) },
	async () => {
		const home = await mkdtemp(path.join(tmpdir(), 'link-sums-install-'));
		try {
			const bin = path.join(home, '.local', 'bin');
			const folder = `dbxcli_3.7.4_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
			await mkdir(path.join(home, folder), { recursive: true });
			await mkdir(bin, { recursive: true });
			await writeFile(
				path.join(home, folder, 'dbxcli'),
				'#!/bin/sh\n[ "$1" = version ] && printf "dbxcli version: 3.7.4\\nSDK version: v6.6.1\\n"\n',
				{ mode: 0o755 }
			);
			execFileSync('tar', ['-czf', path.join(home, 'release.tar.gz'), '-C', home, folder]);
			const script = `
   import fs from 'node:fs';
   import path from 'node:path';
   import {createHash} from 'node:crypto';
   import {execFileSync} from 'node:child_process';
   import {install} from ${JSON.stringify(new URL('../dist/install.js', import.meta.url).href)};
   const home=process.env.HOME, dir=path.join(home,'.openclaw','falcon-link'), base='https://github.com/dropbox/dbxcli/releases/download/v3.7.4/';
   const sha=b=>createHash('sha256').update(b).digest('hex'), archive=fs.readFileSync(path.join(home,'release.tar.gz'));
   const name=${JSON.stringify(folder)}+'.tar.gz', sums=(process.env.MODE==='good'?sha(archive):'0'.repeat(64))+'  '+name+'\\n';
   const assets=[{name,digest:'sha256:'+sha(archive),browser_download_url:base+name},{name:'SHA256SUMS',digest:'sha256:'+sha(Buffer.from(sums)),browser_download_url:base+'SHA256SUMS'}];
   globalThis.fetch=async url=>String(url).startsWith('https://api.github.com/')?Response.json({tag_name:'v3.7.4',assets}):new Response(String(url).endsWith('SHA256SUMS')?sums:archive);
   if(process.env.MODE==='good'){ await install(dir,'dropbox'); if(!execFileSync('dbxcli',['version'],{encoding:'utf8'}).includes('3.7.4'))throw Error('Not installed'); }
   else { let refused=false; try{await install(dir,'dropbox')}catch{refused=true} if(!refused||fs.existsSync(path.join(home,'.local/bin/dbxcli')))throw Error('Installed without a matching SHA256SUMS entry'); }
  `;
			for (const MODE of ['bad', 'good'])
				execFileSync(process.execPath, ['--input-type=module', '-e', script], {
					env: { ...process.env, HOME: home, MODE, PATH: bin + path.delimiter + process.env.PATH },
					stdio: 'pipe'
				});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
);
