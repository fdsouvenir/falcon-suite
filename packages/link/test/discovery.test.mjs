import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../dist/index.js';
import { Registry } from '../dist/store.js';

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
			['microsoft', '1.0.0', 'm365cli']
		]) {
			const folder = path.join(stateDir, 'falcon-link', 'tools', provider, version);
			await mkdir(folder, { recursive: true });
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
		assert.match(result.prependContext, /inherited.*keyring/i);
		assert.equal(
			result.prependSystemContext,
			undefined,
			'connection facts add no operating instructions'
		);
		assert.equal(
			await hook({}, { agentId: 'main', sessionKey: 'agent:main:discord:group:fixture' }),
			undefined
		);
	} finally {
		await service.stop();
		await rm(stateDir, { recursive: true, force: true });
	}
});

test('existing CLI inventories preserve native stores and metadata without inventing ownership or grants', async () => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const root = await mkdtemp(path.join(os.tmpdir(), 'link-existing-'));
	try {
		await writeFile(
			path.join(root, 'gog'),
			`#!${process.execPath}
const args=process.argv.slice(2);
if(args.join(' ')!=='auth list --json --no-input' && args.join(' ')!=='auth list --check --json --no-input')process.exit(9);
console.log(JSON.stringify({accounts:[{email:'fred@example.com',client:'work',scopes:['https://www.googleapis.com/auth/gmail.send'],valid:args.includes('--check'),subject:'fred-id'}]}));
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
		const script = `
import assert from 'node:assert/strict';
import {LinkService} from ${JSON.stringify(new URL('../dist/service.js', import.meta.url).href)};
import {accountBrief} from ${JSON.stringify(new URL('../dist/brief.js', import.meta.url).href)};
const service = new LinkService(process.env.HOME+'/link');
await Promise.all([service.discover(),service.discover()]);
const accounts=service.accounts();assert.equal(accounts.length,2);
const google=accounts.find(a=>a.provider==='google'),microsoft=accounts.find(a=>a.provider==='microsoft');
assert.equal(google.owner,null);assert.equal(google.purpose,null);assert.equal(google.state,'discovered');
assert.equal(microsoft.recorded_scopes,null);assert.equal(google.granted_scopes,null);
const invocation=service.invocation(google.id);assert.deepEqual(invocation.arguments,['--client','work','--account','fred@example.com']);assert.equal(invocation.environment.HOME,process.env.HOME);assert.deepEqual(invocation.credential_environment,{});
assert.deepEqual(service.invocation(microsoft.id).arguments,['--account','work']);
await assert.rejects(()=>service.disconnect(google.id),/original CLI/);
service.metadata(google.id,{kind:'human',id:'fred',name:'Fred'},{kind:'personal'});
await service.check(google.id);
const restarted=new LinkService(process.env.HOME+'/link');await restarted.discover();
assert.equal(restarted.accounts().find(a=>a.id===google.id).owner.name,'Fred');
const brief=accountBrief(restarted.accounts());assert.match(brief,/fred@example.com \\| Fred \\| personal \\| Gmail: send \\(recorded\\)/);assert.match(brief,/fred@business.example \\| unassigned \\| unassigned \\| unknown — not checked/);
`;
		await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, HOME: root, PATH: root + ':' + process.env.PATH },
			timeout: 15000
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
