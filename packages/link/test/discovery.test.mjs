import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../dist/index.js';
import { Registry } from '../dist/store.js';
import { services } from './catalogs.mjs';

test('private brief includes human accounts with compact scopes and failures; public sessions do not', async () => {
	const stateDir = await mkdtemp(path.join(os.tmpdir(), 'link-discovery-'));
	let hook, service;
	plugin.register(
		new Proxy(
			{ id: 'falcon-link' },
			{
				get(target, key) {
					if (key in target) return target[key];
					if (key === 'registerService')
						return (value) => {
							service = value;
						};
					if (key === 'on')
						return (name, value) => {
							if (name === 'before_prompt_build') hook = value;
						};
					return () => {};
				}
			}
		)
	);
	try {
		for (const [provider, version, binary] of [
			['google', '0.47.0', 'gog'],
			['microsoft', '2.2.0', 'm365cli']
		]) {
			const folder = path.join(stateDir, 'falcon-link', 'tools', provider, version);
			await mkdir(folder, { recursive: true });
			await writeFile(path.join(folder, '..', 'current.json'), JSON.stringify({ version }));
			await writeFile(
				path.join(folder, binary),
				`#!${process.execPath}\nconsole.log(JSON.stringify({accounts:[],profiles:[]}));\n`,
				{ mode: 0o700 }
			);
		}
		const registry = new Registry(path.join(stateDir, 'falcon-link'));
		registry.save({
			id: 'acct_fixture',
			provider: 'google',
			email: 'fred@example.com',
			owner: { kind: 'human', id: 'fred', name: 'Fred' },
			purpose: { kind: 'personal' },
			requested: [],
			granted_scopes: null,
			recorded_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
			state: 'check_failed',
			checked_at: null,
			created_at: new Date().toISOString()
		});
		await service.start({ stateDir });
		const result = await hook({}, { agentId: 'main', sessionKey: 'agent:main:dashboard:fixture' });
		assert.match(result?.prependContext ?? '', /Falcon Link integrations and configured accounts/);
		assert.match(
			result.prependContext,
			/fred@example.com \| Fred \| personal \| Gmail: read \(recorded\) — connection check failed/
		);
		assert.doesNotMatch(result.prependContext, /acct_fixture|agent_owned_accounts/);
		assert.match(result.prependContext, /falcon_link_accounts/);
		assert.match(result.prependContext, /keyring password variables are already present/i);
		assert.doesNotMatch(result.prependContext, /\b(?:do not|never)\b/i, 'facts only');
		assert.equal(
			result.prependSystemContext,
			undefined,
			'connection facts add no operating instructions'
		);
		for (const sessionKey of [
			'agent:main:discord:group:fixture',
			'agent:main:slack:channel:fixture',
			'agent:main:matrix:room:fixture'
		])
			assert.equal(await hook({}, { agentId: 'main', sessionKey }), undefined);
		for (const sessionKey of [
			'agent:main:telegram:direct:fixture',
			'agent:main:cron:daily',
			'agent:main:subagent:fixture'
		])
			assert.match(
				(await hook({}, { agentId: 'main', sessionKey }))?.prependContext ?? '',
				/fred@example.com/
			);
	} finally {
		await service.stop();
		await rm(stateDir, { recursive: true, force: true });
	}
});

test('accounts in CLI stores keep native storage and metadata, and reconnect or are removed only themselves with their own client', async () => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const root = await mkdtemp(path.join(os.tmpdir(), 'link-existing-'));
	try {
		await writeFile(
			path.join(root, 'gog'),
			`#!${process.execPath}
const fs=require('fs');const args=process.argv.slice(2),line=args.join(' '),send=v=>console.log(JSON.stringify(v));
fs.appendFileSync(process.env.HOME+'/gog.log',JSON.stringify({args,client:process.env.GOG_CLIENT})+'\\n');
const accounts=[{email:'fred@example.com',client:'work',scopes:['https://www.googleapis.com/auth/gmail.send'],valid:args.includes('--check'),subject:'fred-id'},{email:'other@example.com',client:'work',scopes:[]}].slice(fs.existsSync(process.env.HOME+'/removed')?1:0);
if(args[0]==='--version')console.log('v0.47.1');
else if(line==='auth services --json --no-input')send(${JSON.stringify({ services })});
else if(line==='auth list --json --no-input'||line==='auth list --check --json --no-input')send({accounts});
else if(args[1]==='add'&&args.at(-1)==='1'){const u=new URL('https://accounts.google.com/o/oauth2/auth');u.searchParams.set('state','s');u.searchParams.set('redirect_uri','http://127.0.0.1:1');u.searchParams.set('scope','openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly');send({auth_url:u.href});}
else if(line==='auth remove fred@example.com --force --json --no-input'){fs.writeFileSync(process.env.HOME+'/removed','');send({removed:true});}
else process.exit(9);
`,
			{ mode: 0o700 }
		);
		await writeFile(
			path.join(root, 'm365cli'),
			`#!${process.execPath}
if(process.argv.slice(2).join(' ')!=='auth status --json --no-input')process.exit(9);
console.log(JSON.stringify({profiles:[{name:'work',username:'fred@business.example',auth_mode:'delegated',delegated_scope_workloads:['mail']},{name:'service',username:'application@example.com',auth_mode:'app_only'}]}));
`,
			{ mode: 0o700 }
		);
		const credentials = path.join(root, 'google.json');
		await writeFile(
			credentials,
			JSON.stringify({ installed: { client_id: 'link', client_secret: 'link' } })
		);
		await mkdir(path.join(root, 'link'));
		await writeFile(
			path.join(root, 'link', 'provision.json'),
			JSON.stringify({ google_credentials_file: credentials })
		);
		const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LinkService} from ${JSON.stringify(new URL('../dist/service.js', import.meta.url).href)};
import {accountBrief} from ${JSON.stringify(new URL('../dist/brief.js', import.meta.url).href)};
const service = new LinkService(process.env.HOME+'/link');
await Promise.all([service.discover(),service.discover()]);
const accounts=service.accounts();assert.equal(accounts.length,3);
const google=accounts.find(a=>a.email==='fred@example.com'),microsoft=accounts.find(a=>a.provider==='microsoft');
assert.equal(google.owner,null);assert.equal(google.purpose,null);assert.equal(google.state,'discovered');
assert.equal(microsoft.recorded_scopes,null);assert.equal(google.granted_scopes,null);
const invocation=await service.invocation(google.id);assert.deepEqual(invocation.arguments,['--client','work','--account','fred@example.com']);assert.ok(!('HOME' in invocation.environment));assert.ok(Object.keys(invocation.environment).every(k=>k.startsWith('GOG_')));assert.deepEqual(invocation.inherited_environment,[]);
assert.deepEqual((await service.invocation(microsoft.id)).arguments,['--account','work']);
service.metadata(google.id,{kind:'human',id:'fred',name:'Fred'},{kind:'personal'});
await service.check(google.id);
const restarted=new LinkService(process.env.HOME+'/link');await restarted.discover();
assert.equal(restarted.accounts().find(a=>a.id===google.id).owner.name,'Fred');
const brief=accountBrief(restarted.accounts());assert.match(brief,/fred@example.com \\| Fred \\| personal \\| Gmail: send \\(recorded\\)/);assert.match(brief,/fred@business.example \\| unassigned \\| unassigned \\| unknown — not checked/);
const login=await restarted.start({account_id:google.id,provider:'google',owner:{kind:'human',id:'fred',name:'Fred'},purpose:{kind:'personal'},permissions:['gmail:readonly'],email:'fred@example.com'},'fred');
assert.equal(login.state,'awaiting_consent');restarted.cancel(login.id,'fred');assert.equal(restarted.accounts().find(a=>a.id===google.id).state,'connected','cancelling a reconnect changes nothing');
await restarted.remove(google.id);assert.ok(!restarted.accounts().some(a=>a.id===google.id));
const later=new LinkService(process.env.HOME+'/link');await later.discover();assert.ok(!later.accounts().some(a=>a.email==='fred@example.com'),'a removed account is gone from the CLI store, so discovery does not bring it back');
const calls=fs.readFileSync(process.env.HOME+'/gog.log','utf8').trim().split('\\n').map(l=>JSON.parse(l));
assert.ok(!calls.some(c=>c.args.includes('set')),'the CLI store keeps its own OAuth client');
for(const c of calls.filter(c=>['add','remove'].includes(c.args[1])))assert.equal(c.client,'work');
assert.equal(calls.filter(c=>c.args[1]==='remove').length,1,'other accounts in the store are kept');
`;
		await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: root,
				PATH: root + ':' + process.env.PATH,
				FALCON_LINK_KEYRING_PASSWORD: 'fixture-only'
			},
			timeout: 15000
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
