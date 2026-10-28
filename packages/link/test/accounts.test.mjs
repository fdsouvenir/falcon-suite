import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { services, workloads } from './catalogs.mjs';
const run = promisify(execFile);
const service = new URL('../dist/service.js', import.meta.url).href;
// Full process/CLI boundary: these fixtures emit the CLIs' published JSON schemas.
// They protect account isolation, sign-in-state binding, and no-default-fallback behavior.
async function scenario(body) {
	const dir = await mkdtemp(path.join(tmpdir(), 'link-accounts-'));
	try {
		const fixture = `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args = process.argv.slice(2);\nconst home = process.env.HOME;\nif(args[0] === '--version') { console.log('v0.47.0'); process.exit(); }\nconst send = v => console.log(JSON.stringify(v));\nif(args.includes('services')) send(${JSON.stringify({ services })});\nelse if(args.includes('credentials')) send({ saved: true });\nelse if(args.includes('--step') && args[args.indexOf('--step')+1] === '1') {\n const url = new URL('https://accounts.google.com/o/oauth2/auth'); url.searchParams.set('state',path.basename(home)); url.searchParams.set('redirect_uri','http://127.0.0.1:1'); url.searchParams.set('scope','openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly'); send({ auth_url:url.href });\n} else if(args.includes('--step')) { const failures={'exchange-fails@example.com':'exchange code:','identity-fails@example.com':'fetch authorized email:','storage-fails@example.com':'OAuth completed, but saving the refresh token failed:','unknown-fails@example.com':'unrecognized diagnostic'}; if(failures[args[2]]){console.error(failures[args[2]]+' private-token-fixture');process.exit(7);} const email = args[2]; fs.writeFileSync(path.join(home,'fixture-account.json'),JSON.stringify({ email,subject:email,valid:true,scopes:['recorded-only'] })); send({ stored:true,email }); }\nelse if(args.includes('list')) { const f = path.join(home,'fixture-account.json'); send({ accounts:fs.existsSync(f) ? [JSON.parse(fs.readFileSync(f))] : [] }); }\nelse if(args.includes('remove')) { fs.unlinkSync(path.join(home,'fixture-account.json')); send({ removed:true }); }\nelse process.exit(9);\n`;
		await writeFile(path.join(dir, 'gog'), fixture, { mode: 0o700 });

		await writeFile(
			path.join(dir, 'm365cli'),
			`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);const send=v=>console.log(JSON.stringify(v));const home=process.env.HOME;
if(args[0]==='--version'){console.log('m365cli version v2.2.0 (fixture)');process.exit();}
if(args.includes('workloads')){send(${JSON.stringify({ workloads })});process.exit();}
if(args.includes('login')){
 console.error('private diagnostic never reflected');console.error('To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCDEF123 to authenticate.');
 const id=args[args.indexOf('--profile')+1];fs.writeFileSync(path.join(home,'m365-profile.json'),JSON.stringify({id}));
 setTimeout(()=>send({profile:id}),500);
}else if(args.includes('check')){const id=JSON.parse(fs.readFileSync(path.join(home,'m365-profile.json'))).id;if(args[args.indexOf('--account')+1]!==id)process.exit(2);send({profile:id,verified:true,identity:{id:'provider-'+id,mail:'microsoft@example.com'}});}
else if(args.includes('status')){const file=path.join(home,'m365-profile.json');send({profiles:fs.existsSync(file)?[{name:JSON.parse(fs.readFileSync(file)).id}]:[]});}
else if(args.includes('logout')){fs.unlinkSync(path.join(home,'m365-profile.json'));send({logout:true});}else process.exit(9);
`,
			{ mode: 0o700 }
		);
		const credentials = path.join(dir, 'google.json');
		await writeFile(
			credentials,
			JSON.stringify({ installed: { client_id: 'fixture', client_secret: 'fixture' } }),
			{ mode: 0o600 }
		);
		await writeFile(
			path.join(dir, 'provision.json'),
			JSON.stringify({
				google_credentials_file: credentials,
				microsoft_client_id: '00000000-0000-0000-0000-000000000001'
			}),
			{ mode: 0o600 }
		);
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { LinkService } from ${JSON.stringify(service)}; const dir=${JSON.stringify(dir)}; const l=new LinkService(dir); const owner={kind:'human',id:'fred',name:'Fred'}; const input=email=>({provider:'google',owner,purpose:{kind:'work'},permissions:['gmail-read'],email}); const finish=async login=>{ const u=new URL(login.url); const r=new URL(u.searchParams.get('redirect_uri')); r.searchParams.set('state',u.searchParams.get('state')); r.searchParams.set('code','fixture'); return l.finish(login.id,r.href,'fred'); }; ${body}; l.stop(); console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: { ...process.env, PATH: dir, FALCON_LINK_KEYRING_PASSWORD: 'fixture-only' },
			timeout: 15000
		});
		assert.match(result.stdout, /passed/);
		const mode = await stat(path.join(dir, 'accounts.json'));
		assert.equal(mode.mode & 0o077, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
test('two same-provider accounts retain distinct identities, purposes, encrypted-store environments and explicit selection; disconnect affects only one', async () =>
	scenario(`
 const first=await l.start(input('fred@example.com'),'fred'); assert.equal(first.state,'awaiting_consent'); assert.equal((await finish(first)).state,'connected');
 const second=await l.start({...input('verl@example.com'),owner:{kind:'agent',id:'main',name:'Verl'},purpose:{kind:'other',label:'Operations'}},'fred'); assert.equal((await finish(second)).state,'connected');
 const a=await l.invocation(first.account_id),b=await l.invocation(second.account_id);
 for(const inv of [a,b]) { assert.ok(Object.keys(inv.environment).every(k=>k.startsWith('GOG_')), 'only CLI-specific settings may be passed to normal exec'); }
 for(const key of ['GOG_CONFIG_DIR','GOG_DATA_DIR','GOG_STATE_DIR','GOG_CACHE_DIR']) { assert.ok(a.environment[key]?.startsWith(path.join(dir,'accounts',first.account_id)+'/'),key+' stays account-local'); assert.notEqual(a.environment[key],b.environment[key],key+' is isolated'); }
 assert.notEqual(a.environment.GOG_CONFIG_DIR,b.environment.GOG_CONFIG_DIR); assert.deepEqual(a.arguments,['--account','fred@example.com']); assert.deepEqual(b.arguments,['--account','verl@example.com']); assert.equal(b.account.owner.kind,'agent'); assert.equal(b.account.purpose.label,'Operations'); assert.equal(a.granted_scopes,null); assert.deepEqual(a.account.recorded_scopes,['recorded-only']); assert.doesNotMatch(JSON.stringify(a),/fixture-only/);
 const incomplete = l.registry.get(first.account_id); incomplete.email=null; incomplete.state='check_failed'; l.registry.save(incomplete);
 await l.disconnect(first.account_id); assert.equal(fs.existsSync(path.join(dir,'accounts',first.account_id,'fixture-account.json')),false); assert.equal(l.registry.get(first.account_id).state,'disconnected'); assert.equal((await l.check(second.account_id)).state,'connected');
 await assert.rejects(()=>l.check(first.account_id),/disconnected/);
`));
test('wrong callback state and another operator cannot finish a login; cancellation cannot be completed later', async () =>
	scenario(`
 const login=await l.start(input('fred@example.com'),'fred'); assert.equal(login.state,'awaiting_consent');
 await assert.rejects(()=>l.finish(login.id,'http://127.0.0.1:1?state=wrong&code=fixture','fred'),/state/);
 assert.throws(()=>l.login(login.id,'other'),/not found/);
 l.cancel(login.id,'fred'); await assert.rejects(()=>finish(login),/not waiting/);
 for(const [email,code] of [['exchange-fails@example.com','google_exchange_failed'],['identity-fails@example.com','google_identity_failed'],['storage-fails@example.com','google_token_storage_failed'],['unknown-fails@example.com','google_completion_failed']]){ const failed=await l.start(input(email),'fred'); assert.equal((await finish(failed)).state,'failed'); const saved=l.accounts().find(a=>a.id===failed.account_id); assert.equal(saved.connection_error?.code,code); assert.doesNotMatch(JSON.stringify(saved),/private-token-fixture/); assert.equal(new LinkService(dir).accounts().find(a=>a.id===failed.account_id).connection_error.code,code); }
`));
test('revoked or changed identity fails without falling back to another account', async () =>
	scenario(`
 const login=await l.start(input('fred@example.com'),'fred'); await finish(login); const invocation=await l.invocation(login.account_id);
 fs.writeFileSync(path.join(dir,'accounts',login.account_id,'fixture-account.json'),JSON.stringify({email:'fred@example.com',subject:'changed',valid:true}));
 await assert.rejects(()=>l.check(login.account_id),/identity check failed/); assert.equal(l.registry.get(login.account_id).state,'check_failed'); await assert.rejects(()=>l.invocation(login.account_id),/not connected/);
`));
test('reconnect keeps stable identity; unsupported permissions and invalid custom purpose are rejected', async () =>
	scenario(`
 const login=await l.start(input('fred@example.com'),'fred'); await finish(login);
 const again=await l.start({...input('fred@example.com'),account_id:login.account_id},'fred'); assert.equal(again.account_id,login.account_id); await finish(again); assert.equal(l.accounts().length,1);
 await assert.rejects(()=>l.start({...input('fred@example.com'),permissions:['all']},'fred'),/supported/);
 await assert.rejects(()=>l.start({...input('fred@example.com'),purpose:{kind:'other',label:''}},'fred'),/40 characters/);
 await assert.rejects(()=>l.start({...input('other@example.com'),account_id:login.account_id},'fred'),/same account/);
`));

test('Microsoft device code is person-bound, private stderr stays hidden, and successful consent verifies the exact profile', async () =>
	scenario(`
 const login=await l.start({provider:'microsoft',owner,purpose:{kind:'work'},permissions:['mail-write','mail-send']},'fred');
 let next;for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,30));next=l.login(login.id,'fred');if(next.state==='awaiting_consent')break;}
 assert.equal(next.url,'https://microsoft.com/devicelogin');assert.equal(next.code,'ABCDEF123');assert.doesNotMatch(JSON.stringify(next),/private diagnostic/);
 assert.throws(()=>l.login(login.id,'other'),/not found/);
 for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,30));next=l.login(login.id,'fred');if(next.state==='connected')break;}
 assert.equal(next.state,'connected');const selected=await l.invocation(login.account_id);assert.deepEqual(selected.arguments,['--account',login.account_id]);assert.equal(selected.account.email,'microsoft@example.com');assert.deepEqual(selected.environment,{M365CLI_CONFIG_DIR:path.join(dir,'accounts',login.account_id,'.config','m365cli'),M365CLI_KEYRING_BACKEND:'file'});assert.equal(selected.granted_scopes,null);const incomplete=l.registry.get(login.account_id);incomplete.email=null;incomplete.state='check_failed';l.registry.save(incomplete);await l.disconnect(login.account_id);assert.equal(fs.existsSync(path.join(dir,'accounts',login.account_id,'m365-profile.json')),false);assert.equal(l.registry.get(login.account_id).state,'disconnected');
`));
test('cancelled Microsoft consent cannot become connected after the child exits and changes nothing', async () =>
	scenario(`
 const login=await l.start({provider:'microsoft',owner,purpose:{kind:'personal'},permissions:['mail-send']},'fred');
 l.cancel(login.id,'fred');await new Promise(r=>setTimeout(r,650));assert.equal(l.login(login.id,'fred').state,'cancelled');assert.deepEqual(l.accounts(),[],'a cancelled new sign-in leaves nothing behind');
`));
