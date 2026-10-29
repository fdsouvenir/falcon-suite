import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const dist = (file) => JSON.stringify(new URL(`../dist/${file}`, import.meta.url).href);

// A stand-in for HubSpot Agent CLI 0.16.0 with the JSON shapes and store layout from its
// --help: per-portal logins under $XDG_CONFIG_HOME/hubspot/accounts/<portal>, selected with
// HUBSPOT_PORTAL_ID, and HUBSPOT_ACCESS_TOKEN taking over from any login.
const fixture = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2),line=a.join(' '),env=process.env,send=v=>console.log(JSON.stringify(v));
const store=path.join(env.XDG_CONFIG_HOME||path.join(env.HOME,'.config'),'hubspot');
fs.appendFileSync(env.FIXTURE_LOG,JSON.stringify({line,token:env.HUBSPOT_ACCESS_TOKEN??null,portal:env.HUBSPOT_PORTAL_ID??null,store})+'\\n');
const logins=()=>{const d=path.join(store,'accounts');return fs.existsSync(d)?fs.readdirSync(d).map(p=>({portalId:+p,...JSON.parse(fs.readFileSync(path.join(d,p,'auth.json')))})):[]};
if(a[0]==='--version'){console.log('hubspot 0.16.0 (build 1, commit fixture)');process.exit();}
if(line==='auth login url'){fs.mkdirSync(store,{recursive:true});fs.writeFileSync(path.join(store,'pkce_state.json'),'{}');console.log('https://app.hubspot.com/oauth/authorize/user?client_id=fixture&redirect_uri=https%3A%2F%2Fapp.hubspot.com%2Fcli-auth%2Fcode&response_type=code&code_challenge=x&code_challenge_method=S256');process.exit();}
if(a[0]==='auth'&&a[2]==='exchange'){const code=a[a.indexOf('--code')+1];
 if(code==='na1-expired'){console.error('Authentication failed: HTTP 400 {\\"status\\":\\"BAD_AUTH_CODE\\",\\"message\\":\\"private-diagnostic\\"}');process.exit(1);}
 if(code==='na1-governance'){console.error('This app requires administrator approval under App Governance. private-diagnostic');process.exit(1);}
 if(!fs.existsSync(path.join(store,'pkce_state.json')))process.exit(3);
 const d=path.join(store,'accounts','123');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'auth.json'),JSON.stringify({user:'fred@example.com',scopes:['oauth','crm.objects.contacts.read','crm.objects.contacts.write','crm.objects.deals.read']}));
 console.log('Authenticated successfully (portal 123).');process.exit();}
if(line==='auth list --format json'){send({ok:true,data:logins().map(l=>({...l,active:true,expired:false}))});process.exit();}
if(line==='whoami --format json'){
 if(env.HUBSPOT_ACCESS_TOKEN){if(env.HUBSPOT_ACCESS_TOKEN==='pat-na1-fixture-service-key-0001'){send({ok:true,data:[{authType:'service_key',user:null,portalId:999}]});process.exit();}
  console.error('HUBSPOT_ACCESS_TOKEN is set but the API rejected it (401)');send({ok:false,error:{code:'AUTH_TOKEN_EXPIRED',httpStatus:401}});process.exit(1);}
 const l=logins().filter(l=>!env.HUBSPOT_PORTAL_ID||String(l.portalId)===env.HUBSPOT_PORTAL_ID);
 if(l.length!==1){send({ok:false,error:{message:'Not authenticated.'}});process.exit(1);}
 send({ok:true,data:[{authType:'oauth',user:l[0].user,portalId:l[0].portalId,scopes:l[0].scopes}]});process.exit();}
if(line==='auth logout'){if(!env.HUBSPOT_PORTAL_ID)process.exit(2);fs.rmSync(path.join(store,'accounts',env.HUBSPOT_PORTAL_ID),{recursive:true,force:true});console.log('Logged out.');process.exit();}
process.exit(9);
`;
async function scenario(body) {
	const root = await mkdtemp(path.join(tmpdir(), 'link-hubspot-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'hubspot'), fixture, { mode: 0o700 });
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { LinkService } from ${dist('service.js')}; import { accessSummary } from ${dist('access-summary.js')}; import { accountBrief } from ${dist('brief.js')};
const root=${JSON.stringify(root)}, dir=path.join(root,'link'), l=new LinkService(dir), owner={kind:'human',id:'fred',name:'Fred'};
const calls=()=>fs.readFileSync(process.env.FIXTURE_LOG,'utf8').trim().split('\\n').map(c=>JSON.parse(c));
const sh=(prefix,args)=>JSON.parse(execFileSync('sh',['-c',prefix+' '+args],{encoding:'utf8'}));
${body}; l.stop(); console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: path.join(root, '.config'),
				PATH: bin + path.delimiter + process.env.PATH,
				FIXTURE_LOG: path.join(root, 'calls.log'),
				// A host-wide token must never decide which account a sign-in uses.
				HUBSPOT_ACCESS_TOKEN: 'inherited-host-token',
				HUBSPOT_PORTAL_ID: '777'
			},
			timeout: 15000
		});
		assert.match(result.stdout, /passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('HubSpot sign-in takes the pasted code, confirms the portal and granted access, and gives agents a command for that account only', () =>
	scenario(`
 const input={provider:'hubspot',owner,purpose:{kind:'work'},permissions:[]};
 const expired=await l.start(input,'fred'); assert.equal(expired.state,'awaiting_consent'); assert.equal(new URL(expired.url).hostname,'app.hubspot.com'); assert.equal(expired.paste.kind,'text');
 const failed=await l.finish(expired.id,'na1-expired','fred'); assert.equal(failed.state,'failed'); assert.match(failed.message,/expired or was already used/);
 assert.equal(l.registry.get(expired.account_id).connection_error.code,'hubspot_code_expired');
 const denied=await l.finish((await l.start({...input,account_id:expired.account_id},'fred')).id,'na1-governance','fred');
 assert.equal(l.registry.get(expired.account_id).connection_error.code,'hubspot_admin_approval'); assert.match(denied.message,/administrator/);
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'accounts.json'),'utf8'),/private-diagnostic/);
 const login=await l.start({...input,account_id:expired.account_id},'fred');
 const done=await l.finish(login.id,'https://app.hubspot.com/cli-auth/code?code=na1-good','fred'); assert.equal(done.state,'connected',done.message); assert.deepStrictEqual(JSON.parse(JSON.stringify(done)),done,'the Gateway accepts only plain JSON');
 const a=l.registry.get(login.account_id); assert.equal(a.email,'fred@example.com'); assert.equal(a.provider_id,'123'); assert.equal(a.auth,'oauth');
 assert.deepEqual(accessSummary(a).items,['View and change contacts','View deals']);
 assert.ok(calls().filter(c=>c.line!=='--version').every(c=>c.token===null&&c.portal!=='777'),'inherited token and portal never reach account runs');
 assert.ok(calls().filter(c=>c.line.startsWith('auth login')).every(c=>c.store.startsWith(path.join(dir,'accounts',a.id))),'sign-in uses the account own store');
 const inv=await l.invocation(a.id); assert.deepEqual(inv.environment,{XDG_CONFIG_HOME:path.join(dir,'accounts',a.id,'.config'),HUBSPOT_PORTAL_ID:'123'});
 assert.equal(sh(inv.command_prefix,'whoami --format json').data[0].user,'fred@example.com','the prefix selects this account despite the inherited token');
 assert.match(accountBrief(l.accounts()),/fred@example.com \\| Fred \\| work \\| oauth; crm.objects.contacts.read/);
 await l.remove(a.id); assert.ok(calls().some(c=>c.line==='auth logout'&&c.portal==='123')); assert.equal(fs.existsSync(path.join(dir,'accounts',a.id)),false); assert.deepEqual(l.accounts(),[]);
`));

test('existing HubSpot logins are discovered by portal, and a service key is verified and kept only in its account settings', () =>
	scenario(`
 fs.mkdirSync(path.join(root,'.config/hubspot/accounts/555'),{recursive:true}); fs.writeFileSync(path.join(root,'.config/hubspot/accounts/555/auth.json'),JSON.stringify({user:'ops@example.com',scopes:['oauth','tickets']}));
 await l.discover(); const found=l.accounts().find(a=>a.provider==='hubspot'); assert.equal(found.provider_id,'555'); assert.equal(found.state,'discovered');
 assert.deepEqual((await l.invocation(found.id)).environment,{HUBSPOT_PORTAL_ID:'555'});
 const input={provider:'hubspot',owner,purpose:{kind:'work'}};
 await assert.rejects(()=>l.connectKey({...input,key:'not a key'}),/doesn't look like/);
 await assert.rejects(()=>l.connectKey({...input,key:'pat-na1-revoked-key-000000'}),/didn't accept/);
 assert.equal(l.accounts().length,1,'a rejected key leaves nothing behind'); assert.deepEqual(fs.readdirSync(path.join(dir,'accounts')),[]);
 const a=await l.connectKey({...input,key:'pat-na1-fixture-service-key-0001'}); assert.equal(a.auth,'service_key'); assert.equal(a.provider_id,'999'); assert.equal(a.state,'connected');
 const file=path.join(dir,'accounts',a.id,'.config/hubspot/.env'); assert.equal(fs.statSync(file).mode&0o777,0o600); assert.match(fs.readFileSync(file,'utf8'),/fixture-service-key/);
 const inv=await l.invocation(a.id);
 for(const text of [fs.readFileSync(path.join(dir,'accounts.json'),'utf8'),JSON.stringify(inv),JSON.stringify(l.accounts()),accountBrief(l.accounts())]) assert.doesNotMatch(text,/fixture-service-key/);
 assert.equal(sh(inv.command_prefix,'whoami --format json').data[0].authType,'service_key');
 assert.equal((await l.check(a.id)).state,'connected');
 assert.match(accountBrief(l.accounts()),/HubSpot account 999 \\(service key\\)/);
 await l.remove(a.id); assert.equal(fs.existsSync(file),false);
`));
