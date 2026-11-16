import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const dist = (file) => JSON.stringify(new URL(`../dist/${file}`, import.meta.url).href);

// A stand-in for link-cli 1.5.1 (cli.tsx, commands/auth/index.tsx, auth/storage.ts): the store is
// `--auth <file>`, else LINK_AUTH_FILE, else $XDG_CONFIG_HOME/link-cli-nodejs/config.json, and
// LINK_ACCESS_TOKEN takes over from it. `auth login` saves a pending device authorization and
// prints the address and phrase; `auth status --interval` waits for the person (here: a
// decision file the test writes) and saves the granted tokens; `auth logout` revokes the refresh
// token and deletes the file. The token endpoint echoes scopes comma-separated.
const fixture = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const argv=process.argv.slice(2),env=process.env,root=env.FIXTURE_ROOT,out=v=>console.log(JSON.stringify(v));
const log=(e)=>fs.appendFileSync(path.join(root,'calls.ndjson'),JSON.stringify(e)+'\\n');
if(argv[0]==='--version'){console.log('1.5.1');process.exit();}
let file=env.LINK_AUTH_FILE;const i=argv.indexOf('--auth');if(i!==-1){file=argv[i+1];argv.splice(i,2);}
file=file?(path.extname(file)==='.json'?file:file+'.json'):path.join(env.XDG_CONFIG_HOME,'link-cli-nodejs','config.json');
const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return {auth:null,pendingDeviceAuth:null}}};
const write=s=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(s),{mode:0o600});};
const all=(flag)=>argv.flatMap((a,n)=>a===flag?[argv[n+1]]:[]);
const cmd=argv.filter(a=>!a.startsWith('--')).slice(0,2).join(' ');
const token=()=>env.LINK_ACCESS_TOKEN||read().auth?.access_token;
const status=s=>s.auth?{authenticated:true,access_token:'x...',token_type:'Bearer',credentials_path:file,scope:s.auth.scope,authorization_details:s.auth.authorization_details}:{authenticated:false,credentials_path:file};
if(cmd==='auth login'){log({login:argv,file});const s=read();if(s.auth){out([{authenticated:true,message:'You are already logged in.'}]);process.exit();}
 const actions=argv.includes('--no-financial-insights')?[]:all('--source-actions').length?all('--source-actions'):['read_balances','read_external_transactions','read_link_transactions','read_source_details'];
 write({auth:null,pendingDeviceAuth:{device_code:'dc',scope:all('--scope')[0],actions,phrase:'apple-grape'}});
 out([{verification_url:'https://app.link.com/device/setup?code=apple-grape',phrase:'apple-grape',instruction:'…'}]);}
else if(cmd==='auth status'&&argv.includes('--interval')){const decision=path.join(root,'decision.json');
 const wait=()=>{if(!fs.existsSync(decision))return setTimeout(wait,50);const d=JSON.parse(fs.readFileSync(decision,'utf8'));fs.rmSync(decision);
  if(d.deny){console.log(JSON.stringify({code:'UNKNOWN',message:'Authorization denied by user.'}));process.exit(1);}
  const p=read().pendingDeviceAuth,actions=p.actions.filter(a=>!(d.withhold??[]).includes(a));
  write({auth:{access_token:'at-'+d.user+'-'+Date.now(),refresh_token:'rt-'+d.user+'-'+Date.now(),token_type:'Bearer',expires_in:3600,scope:p.scope.split(' ').join(','),authorization_details:actions.length?[{type:'source',actions}]:undefined},pendingDeviceAuth:null});
  out([{authenticated:false,pending:true},status(read())]);};wait();}
else if(cmd==='auth status'){const s=read();write(s);out([status(s)]);}
else if(cmd==='auth logout'){const s=read();if(s.auth)log({revoked:s.auth.refresh_token});fs.rmSync(file,{force:true});out({authenticated:false});}
else if(cmd==='user-info retrieve'){const t=token();const who=t&&t.split('-')[1];
 if(!who){out({code:'NOT_AUTHENTICATED',message:'Not authenticated.'});process.exit(1);}
 out({id:'usr_'+who,email:who+'@example.com',name:who[0].toUpperCase()+who.slice(1)+' Doe',first_name:null,last_name:null,phone:null});}
else process.exit(9);
`;

// Sign-in is link-cli's own device-code flow: Link shows the address and phrase, link-cli waits for
// approval, and the account is confirmed before its file is replaced.
test('Stripe Link signs in with the chosen scopes and source actions, keeps each account in its own file, and signs it out on removal', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'link-stripe-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'link-cli'), fixture, { mode: 0o700 });
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LinkService } from ${dist('service.js')}; import { accessSummary } from ${dist('access-summary.js')};
const root=${JSON.stringify(root)}, dir=path.join(root,'link'), l=new LinkService(dir), owner={kind:'human',id:'fred',name:'Fred'};
const calls=()=>fs.existsSync(path.join(root,'calls.ndjson'))?fs.readFileSync(path.join(root,'calls.ndjson'),'utf8').trim().split('\\n').map(JSON.parse):[];
const logins=()=>calls().filter(c=>c.login).map(c=>c.login), revoked=()=>calls().filter(c=>c.revoked).map(c=>c.revoked);
const input=(permissions,account_id)=>({provider:'stripe-link',owner,purpose:{kind:'personal'},permissions,...(account_id?{account_id}:{})});
const decide=async(login,d)=>{fs.writeFileSync(path.join(root,'decision.json'),JSON.stringify(d));
 for(let i=0;i<200;i++){const s=l.login(login.id,'fred');if(!['awaiting_consent','verifying'].includes(s.state))return s;await sleep(25);} throw Error('sign-in did not settle');};

// Payments and one financial-data row: link-cli is asked for exactly those.
let login=await l.start(input(['payments:on','balances:on']),'fred');
assert.equal(login.state,'awaiting_consent',login.message);
assert.equal(new URL(login.url).hostname,'app.link.com'); assert.equal(login.code,'apple-grape');
const first=logins().at(-1);
assert.deepEqual(first.slice(first.indexOf('--client-name'),first.indexOf('--format')),['--client-name','Falcon Link','--scope','userinfo:read payment_methods.agentic','--source-actions','read_balances']);
let done=await decide(login,{user:'jane'}); assert.equal(done.state,'connected',done.message);
const jane=l.registry.get(done.account_id);
assert.equal(jane.email,'jane@example.com'); assert.equal(jane.display_name,'Jane Doe'); assert.equal(jane.provider_id,'usr_jane');
assert.deepEqual(accessSummary(jane).items,['Get payment credentials','See balances']);
const file=path.join(dir,'accounts',jane.id,'link-cli','auth.json');
assert.equal(fs.statSync(file).mode&0o777,0o600);
assert.deepEqual(fs.readdirSync(path.join(dir,'stripe-link')),[],'no sign-in file is left behind');
const inv=await l.invocation(jane.id);
assert.deepEqual(inv.environment,{LINK_AUTH_FILE:file});
assert.equal(inv.command_prefix,"env -u LINK_ACCESS_TOKEN -u LINK_REFRESH_TOKEN LINK_AUTH_FILE='"+file+"' '"+path.join(root,'bin','link-cli')+"'");
assert.deepEqual([inv.granted_scopes,inv.granted_source_actions],[['userinfo:read','payment_methods.agentic'],['read_balances']]);

// No financial data chosen: link-cli would otherwise ask for all four source actions.
login=await l.start(input(['link_transactions:on']),'fred');
assert.deepEqual(logins().at(-1).slice(logins().at(-1).indexOf('--scope'),-2),['--scope','userinfo:read','--source-actions','read_link_transactions']);
await l.cancel(login.id,'fred');
login=await l.start(input(['payments:on']),'fred');
assert.ok(logins().at(-1).includes('--no-financial-insights'));
const declined=await decide(login,{deny:true}); assert.equal(declined.state,'cancelled'); assert.equal(l.accounts().length,1);

// Reconnecting signs in a different Link user: nothing changes, and that sign-in is signed out.
const before=fs.readFileSync(file,'utf8');
login=await l.start(input(['payments:on'],jane.id),'fred');
const wrong=await decide(login,{user:'bob'}); assert.equal(wrong.state,'failed'); assert.match(wrong.message,/Sign in as jane@example.com/);
assert.equal(fs.readFileSync(file,'utf8'),before,"jane's sign-in is kept");
for(let i=0;i<200&&!revoked().some(t=>t.startsWith('rt-bob-'));i++)await sleep(25);
assert.ok(revoked().some(t=>t.startsWith('rt-bob-')),"bob's sign-in is signed out");

// Reconnecting with more access replaces the file and signs out the one it replaced. A chosen
// action Link didn't grant is named on the card.
const old=JSON.parse(before).auth.refresh_token;
login=await l.start(input(['payments:on','balances:on','link_transactions:on'],jane.id),'fred');
done=await decide(login,{user:'jane',withhold:['read_link_transactions']}); assert.equal(done.state,'connected',done.message);
assert.notEqual(fs.readFileSync(file,'utf8'),before); assert.ok(revoked().includes(old));
assert.match(accessSummary(l.registry.get(jane.id),await l.catalog('stripe-link')).note,/Stripe Link didn't grant: Link transactions: See Link transactions/);

// A sign-in in link-cli's own store is listed, and LINK_ACCESS_TOKEN on the host doesn't take over.
fs.mkdirSync(path.join(root,'config','link-cli-nodejs'),{recursive:true});
fs.writeFileSync(path.join(root,'config','link-cli-nodejs','config.json'),JSON.stringify({auth:{access_token:'at-kim-1',refresh_token:'rt-kim-1',scope:'userinfo:read'}}));
await l.discover();
const kim=l.accounts().find(a=>a.external); assert.ok(kim);
await l.check(kim.id); assert.equal(l.registry.get(kim.id).email,'kim@example.com');

// Removing signs out only this account's file.
const current=JSON.parse(fs.readFileSync(file,'utf8')).auth.refresh_token;
await l.remove(jane.id);
assert.ok(revoked().includes(current)); assert.equal(fs.existsSync(file),false);
assert.ok(fs.existsSync(path.join(root,'config','link-cli-nodejs','config.json')));
l.stop(); console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: path.join(root, 'home'),
				XDG_CONFIG_HOME: path.join(root, 'config'),
				LINK_ACCESS_TOKEN: 'at-host-1',
				LINK_AUTH_FILE: '',
				FIXTURE_ROOT: root,
				PATH: bin + path.delimiter + process.env.PATH
			},
			timeout: 60000
		});
		assert.match(result.stdout, /passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
