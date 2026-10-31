import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

// HubSpot's skills reach every agent through OpenClaw's shared skills directory. Link must
// install them under hubspot-* names from a pinned commit, follow upstream changes, and
// never remove or replace skills it did not install.
test('official skills install once for all agents under hubspot- names, update from upstream and remove only what Link installed', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'link-skills-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		// Native `openclaw skills install <dir> --as <slug> --global --force` copies into the
		// shared directory and records the source, as OpenClaw 2026.9.6 does.
		await writeFile(
			path.join(bin, 'openclaw'),
			`#!${process.execPath}
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);
fs.appendFileSync(process.env.HOME+'/openclaw.log',a.join(' ')+'\\n');
if(a[0]!=='skills'||a[1]!=='install'||!a.includes('--global'))process.exit(9);
const slug=a[a.indexOf('--as')+1],target=path.join(process.env.OPENCLAW_STATE_DIR,'skills',slug);
fs.rmSync(target,{recursive:true,force:true});fs.cpSync(a[2],target,{recursive:true});
fs.mkdirSync(target+'/.openclaw');fs.writeFileSync(target+'/.openclaw/source-origin.json',JSON.stringify({version:1,source:'path',spec:a[2],slug}));
`,
			{ mode: 0o700 }
		);
		const tarball = async (commit, slugs) => {
			const top = path.join(root, 'src', `HubSpot-agent-cli-skills-${commit.slice(0, 7)}`);
			await rm(path.join(root, 'src'), { recursive: true, force: true });
			await mkdir(path.join(top, 'not-a-skill'), { recursive: true });
			await writeFile(path.join(top, 'LICENSE'), 'Apache License 2.0');
			for (const slug of slugs) {
				await mkdir(path.join(top, slug));
				await writeFile(
					path.join(top, slug, 'SKILL.md'),
					`---\nname: ${slug}\ndescription: Use HubSpot ${slug}.\n---\n\n# ${slug}\n`
				);
			}
			const file = path.join(root, `${commit}.tgz`);
			execFileSync('tar', ['-czf', file, '-C', path.join(root, 'src'), path.basename(top)]);
			return file;
		};
		const first = 'a'.repeat(40),
			second = 'b'.repeat(40);
		const archives = {
			[first]: await tarball(first, ['work', 'crm-lookup']),
			[second]: await tarball(second, ['work'])
		};
		const state = path.join(root, 'state');
		await mkdir(path.join(state, 'skills', 'hubspot-mine'), { recursive: true });
		await writeFile(path.join(state, 'skills', 'hubspot-mine', 'SKILL.md'), 'someone else');
		const script = `
import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { installSkills, removeSkills, skillsStatus } from ${JSON.stringify(new URL('../dist/skills.js', import.meta.url).href)};
const state=${JSON.stringify(state)}, dir=path.join(state,'falcon-link'), skills=path.join(state,'skills'), archives=${JSON.stringify(archives)};
let head='${first}';
globalThis.fetch=async url=>{ url=String(url);
 if(url==='https://api.github.com/repos/HubSpot/agent-cli-skills/commits/main')return Response.json({sha:head});
 const m=/^https:\\/\\/api\\.github\\.com\\/repos\\/HubSpot\\/agent-cli-skills\\/tarball\\/([a-f0-9]{40})$/.exec(url);
 return m?new Response(fs.readFileSync(archives[m[1]])):new Response('',{status:404}); };
fs.mkdirSync(dir,{recursive:true});
assert.equal((await skillsStatus(dir,'hubspot')).state,'not_installed');
await installSkills(dir,'hubspot');
assert.deepEqual(fs.readdirSync(skills).sort(),['hubspot-crm-lookup','hubspot-mine','hubspot-work']);
assert.match(fs.readFileSync(path.join(skills,'hubspot-work/SKILL.md'),'utf8'),/^---\\nname: hubspot-work\\n/);
assert.ok(fs.existsSync(path.join(skills,'hubspot-work/LICENSE')),'the Apache-2.0 license travels with each skill');
assert.ok(fs.readFileSync(process.env.HOME+'/openclaw.log','utf8').trim().split('\\n').every(l=>/ --as hubspot-[a-z-]+ --global/.test(l)));
const installed=await skillsStatus(dir,'hubspot'); assert.equal(installed.state,'installed'); assert.equal(installed.commit,head); assert.equal(installed.count,2);
head='${second}';
assert.equal((await skillsStatus(dir,'hubspot')).state,'installed','upstream checks are cached');
await installSkills(dir,'hubspot');
assert.deepEqual(fs.readdirSync(skills).sort(),['hubspot-mine','hubspot-work'],'a skill dropped upstream is removed; others are kept');
assert.equal((await skillsStatus(dir,'hubspot')).commit,head);
fs.mkdirSync(path.join(skills,'hubspot-crm-lookup')); fs.writeFileSync(path.join(skills,'hubspot-crm-lookup/SKILL.md'),'someone else');
await removeSkills(dir,'hubspot');
assert.deepEqual(fs.readdirSync(skills).sort(),['hubspot-crm-lookup','hubspot-mine']);
assert.equal(fs.readFileSync(path.join(skills,'hubspot-mine/SKILL.md'),'utf8'),'someone else');
assert.equal((await skillsStatus(dir,'hubspot')).state,'not_installed');
console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, HOME: root, PATH: bin + path.delimiter + process.env.PATH },
			timeout: 20000
		});
		assert.match(result.stdout, /passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
