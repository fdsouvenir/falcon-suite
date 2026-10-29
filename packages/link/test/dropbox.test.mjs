import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const dist = (file) => JSON.stringify(new URL(`../dist/${file}`, import.meta.url).href);

// A stand-in for dbxcli 3.7.4 that reads credentials the way cmd/auth.go and cmd/root.go do:
// DBXCLI_AUTH_FILE (else ~/.config/dbxcli/auth.json), domain '', slot personal / teamManage
// (team commands) / teamAccess (--as-member), and DBXCLI_ACCESS_TOKEN taking over from all.
const fixture = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2),env=process.env,send=v=>console.log(JSON.stringify(v));
if(a[0]==='version'){console.log('dbxcli version: 3.7.4\\nSDK version: v6.6.1\\nSpec version: 795d056');process.exit();}
const fail=code=>{send({ok:false,schema_version:'1',error:{code}});process.exit(4);};
let token=env.DBXCLI_ACCESS_TOKEN;
if(!token){const file=env.DBXCLI_AUTH_FILE||path.join(env.HOME,'.config/dbxcli/auth.json');
 const slot=a[0]==='team'?'teamManage':a.includes('--as-member')?'teamAccess':'personal';
 const c=JSON.parse(fs.readFileSync(file,'utf8'))['']?.[slot];
 if(!c?.access_token||!c.refresh_token||!c.app_key||c.token_type!=='Bearer'||isNaN(Date.parse(c.expiry)))fail('auth_required');
 token=c.access_token;}
const who=JSON.parse(env.FIXTURE_ACCOUNTS)[token];if(!who)fail('auth_failed');
const ok=(command,result)=>send({ok:true,schema_version:'1',command,input:{},results:[{status:'found',kind:'x',input:{},result}],warnings:[]});
if(a[0]==='account'&&who.account_id)ok('account',{type:'account',account_id:who.account_id,email:who.email,...(who.team?{team:{id:who.team,name:'Fixture team'}}:{})});
else if(a[0]==='team'&&a[1]==='info'&&who.team_id)ok('team info',{type:'team',name:'Fixture team',team_id:who.team_id});
else fail('not_supported');
`;
const accounts = {
	'sl.fred': { account_id: 'dbid:fred', email: 'fred@example.com', team: 'dbtid:one' },
	'sl.team': { team_id: 'dbtid:one' },
	'sl.kim': { account_id: 'dbid:kim', email: 'kim@example.com' },
	'sl.cli': { account_id: 'dbid:cli', email: 'cli@example.com' },
	'host-token': { account_id: 'dbid:host', email: 'host@example.com' }
};
// Token responses by authorization code, in Dropbox's /oauth2/token shape.
const tokens = {
	'fred-code-0001': ['sl.fred', 'dbid:fred', null],
	'team-code-0001': ['sl.team', null, 'dbtid:one'],
	'kim-code-00001': ['sl.kim', 'dbid:kim', null],
	'less-code-0001': ['sl.kim', 'dbid:kim', null, 'account_info.read']
};
async function scenario(body) {
	const root = await mkdtemp(path.join(tmpdir(), 'link-dropbox-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'dbxcli'), fixture, { mode: 0o700 });
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { LinkService } from ${dist('service.js')}; import { accessSummary } from ${dist('access-summary.js')};
const root=${JSON.stringify(root)}, dir=path.join(root,'link'), owner={kind:'human',id:'fred',name:'Fred'};
fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'provision.json'),JSON.stringify({dropbox_app_key:'fixtureappkey1'}));
const l=new LinkService(dir), exchanges=[], tokens=${JSON.stringify(tokens)}, people=${JSON.stringify(accounts)};
let requested='';
globalThis.fetch=async (url,o={})=>{ url=String(url);
 if(url==='https://api.dropboxapi.com/oauth2/token'){ const p=Object.fromEntries(new URLSearchParams(o.body)); exchanges.push(p); const t=tokens[p.code]; if(!t)return Response.json({error:'invalid_grant'},{status:400});
  return Response.json({access_token:t[0],refresh_token:'private-refresh-'+t[0],expires_in:14400,token_type:'bearer',scope:t[3]??requested,...(t[1]?{account_id:t[1]}:{}),...(t[2]?{team_id:t[2]}:{})}); }
 if(url==='https://api.dropboxapi.com/2/users/get_current_account'){ const who=people[o.headers.Authorization.slice(7)]; return Response.json({account_id:who.account_id,email:who.email,...(who.team?{team:{id:who.team}}:{})}); }
 throw new Error('unexpected '+url); };
// Dropbox grants exactly what the authorize address asked for.
const ask=login=>{ requested=new URL(login.url).searchParams.get('scope'); return requested.split(' ').sort(); };
const file=id=>path.join(dir,'accounts',id,'.config/dbxcli/auth.json');
const input=(permissions,extra={})=>({provider:'dropbox',owner,purpose:{kind:'work'},permissions,...extra});
${body}; l.stop(); console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: root,
				PATH: bin + path.delimiter + process.env.PATH,
				FIXTURE_ACCOUNTS: JSON.stringify(accounts),
				// A host-wide token must never decide which account Link or an agent uses.
				DBXCLI_ACCESS_TOKEN: 'host-token'
			},
			timeout: 15000
		});
		assert.match(result.stdout, /passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('Dropbox asks for exactly the chosen access, and team administration is a second sign-in saved in the team slots dbxcli reads', () =>
	scenario(`
 await assert.rejects(()=>l.start(input(['files:permanent-delete']),'fred'),/supported/,'permanent delete needs View and change files');
 const login=await l.start(input(['files:change','files:permanent-delete','sharing:view','members:view']),'fred');
 assert.equal(login.state,'awaiting_consent'); assert.deepEqual(login.step,{number:1,total:2}); assert.equal(login.paste.kind,'text');
 const first=new URL(login.url); assert.equal(first.origin+first.pathname,'https://www.dropbox.com/oauth2/authorize');
 assert.equal(first.searchParams.get('client_id'),'fixtureappkey1'); assert.equal(first.searchParams.get('token_access_type'),'offline'); assert.equal(first.searchParams.get('code_challenge_method'),'S256'); assert.equal(first.searchParams.get('redirect_uri'),null);
 assert.deepEqual(ask(login),['account_info.read','files.content.read','files.content.write','files.metadata.read','files.metadata.write','files.permanent_delete','sharing.read']);
 const second=await l.finish(login.id,' fred-code-0001 ','fred'); assert.equal(second.state,'awaiting_consent',second.message); assert.deepEqual(second.step,{number:2,total:2});
 assert.deepEqual(ask(second),['members.read','team_info.read']); assert.notEqual(new URL(second.url).searchParams.get('state'),first.searchParams.get('state'));
 assert.equal(fs.existsSync(file(login.account_id)),false,'nothing is saved before every sign-in finishes');
 const done=await l.finish(login.id,'team-code-0001','fred'); assert.equal(done.state,'connected',done.message);
 assert.ok(exchanges.every(p=>p.client_id==='fixtureappkey1'&&p.code_verifier&&!p.redirect_uri&&!p.client_secret));
 const saved=JSON.parse(fs.readFileSync(file(login.account_id),'utf8'))['']; assert.equal(fs.statSync(file(login.account_id)).mode&0o777,0o600);
 assert.equal(saved.personal.access_token,'sl.fred'); assert.equal(saved.personal.app_key,'fixtureappkey1'); assert.equal(saved.teamManage.access_token,'sl.team'); assert.equal(saved.teamAccess,undefined,'no member access without team files');
 const a=l.registry.get(login.account_id); assert.equal(a.email,'fred@example.com'); assert.equal(a.provider_id,'dbid:fred');
 assert.deepEqual(accessSummary(a).items,['View and change files',"Permanently delete files (can't be recovered)",'See shared links and folders','See team details','See team members']);
 const inv=await l.invocation(a.id); assert.deepEqual(inv.environment,{DBXCLI_AUTH_FILE:file(a.id)}); assert.deepEqual(inv.team_granted_scopes,['team_info.read','members.read']);
 assert.equal(JSON.parse(execFileSync('sh',['-c',inv.command_prefix+' account --output=json'],{encoding:'utf8'})).results[0].result.email,'fred@example.com','the prefix selects this account despite the host token');
 assert.equal(JSON.parse(execFileSync('sh',['-c',inv.command_prefix+' team info --output=json'],{encoding:'utf8'})).results[0].result.team_id,'dbtid:one');
 assert.doesNotMatch(JSON.stringify([inv,l.accounts(),fs.readFileSync(path.join(dir,'accounts.json'),'utf8')]),/private-refresh|sl\\.fred/);
 assert.equal((await l.check(a.id)).state,'connected');
 const change=await l.start(input(['files:view'],{account_id:a.id}),'fred'); assert.equal(change.step,undefined); ask(change);
 assert.equal((await l.finish(change.id,'fred-code-0001','fred')).state,'connected');
 assert.equal(JSON.parse(fs.readFileSync(file(a.id),'utf8'))[''].teamManage,undefined,'dropping team administration removes the team sign-in');
 assert.deepEqual(accessSummary(l.registry.get(a.id)).items,['View files']);
`));

test('Dropbox reconnect must be the same account, a short grant saves nothing, and dbxcli sign-ins are found, checked and removed', () =>
	scenario(`
 const login=await l.start(input(['files:view']),'fred'); ask(login); assert.equal((await l.finish(login.id,'fred-code-0001','fred')).state,'connected');
 const other=await l.start(input(['files:view'],{account_id:login.account_id}),'fred'); ask(other);
 const refused=await l.finish(other.id,'kim-code-00001','fred'); assert.equal(refused.state,'failed'); assert.equal(l.registry.get(login.account_id).connection_error.code,'dropbox_wrong_account');
 assert.equal(JSON.parse(fs.readFileSync(file(login.account_id),'utf8'))[''].personal.access_token,'sl.fred','the working sign-in is kept');
 const short=await l.start(input(['contacts:view']),'fred'); ask(short); assert.equal((await l.finish(short.id,'less-code-0001','fred')).state,'failed');
 assert.equal(l.registry.get(short.account_id).connection_error.code,'dropbox_permission_mismatch'); assert.equal(fs.existsSync(file(short.account_id)),false);
 const solo=await l.start(input(['files:view','groups:view']),'fred'); ask(solo); assert.equal((await l.finish(solo.id,'kim-code-00001','fred')).state,'failed');
 assert.equal(l.registry.get(solo.account_id).connection_error.code,'dropbox_no_team');
 const store=path.join(root,'.config/dbxcli/auth.json'); fs.mkdirSync(path.dirname(store),{recursive:true});
 fs.writeFileSync(store,JSON.stringify({'':{personal:{access_token:'sl.cli',refresh_token:'r',token_type:'Bearer',expiry:new Date(Date.now()+3600e3).toISOString(),app_key:'dbxcli-own'}},'test.example':{personal:'keep'}}));
 await l.discover(); const found=l.accounts().find(x=>x.external); assert.equal(found.state,'discovered'); assert.equal(found.email,null);
 assert.deepEqual((await l.invocation(found.id)).environment,{DBXCLI_AUTH_FILE:store});
 assert.equal((await l.check(found.id)).email,'cli@example.com');
 await l.remove(found.id); assert.equal(fs.existsSync(store),false); assert.ok(!l.accounts().some(x=>x.id===found.id));
 await l.remove(login.account_id); assert.equal(fs.existsSync(path.join(dir,'accounts',login.account_id)),false);
`));
