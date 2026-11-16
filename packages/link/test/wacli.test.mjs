import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const dist = (file) => JSON.stringify(new URL(`../dist/${file}`, import.meta.url).href);

// A stand-in for wacli 0.26.1 (cmd/wacli/root.go, auth.go, sync.go): the store is `--store`, else
// WACLI_STORE_DIR; JSON output is {success, data, error}; `--events` writes NDJSON lifecycle
// events on stderr. `auth` shows a QR code that changes while it waits (or a pairing code with
// `--phone`) until the person links (here: a decision file the test writes), then exits after its
// first sync. `sync --follow` holds the store's lock until stopped; `auth logout` needs that lock;
// WACLI_READONLY rejects both.
const fixture = `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const argv=process.argv.slice(2),env=process.env,root=env.FIXTURE_ROOT;
const log=(e)=>fs.appendFileSync(path.join(root,'calls.ndjson'),JSON.stringify(e)+'\\n');
const flag=(f)=>{const i=argv.indexOf(f);if(i===-1)return null;const v=argv[i+1];argv.splice(i,2);return v;};
const bool=(f)=>{const i=argv.indexOf(f);if(i===-1)return false;argv.splice(i,1);return true;};
if(argv[0]==='version'){console.log('0.26.1');process.exit();}
const store=flag('--store')||env.WACLI_STORE_DIR,events=bool('--events'),readOnly=bool('--read-only')||env.WACLI_READONLY==='1';bool('--json');
const phone=flag('--phone'),cmd=argv.join(' ');
const out=(data)=>console.log(JSON.stringify({success:true,data,error:null}));
const fail=(error)=>{if(events)console.error(JSON.stringify({event:'error',data:{message:error},ts:Date.now()}));else console.log(JSON.stringify({success:false,data:null,error}));process.exit(1);};
const emit=(event,data)=>console.error(JSON.stringify({event,data,ts:Date.now()}));
const session=path.join(store,'session.db'),lock=path.join(store,'LOCK.pid');
const read=()=>{try{return JSON.parse(fs.readFileSync(session,'utf8'))}catch{return {}}};
const locked=()=>{try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);return true}catch{return false}};
const writes=['auth','sync --follow','auth logout'];
if(readOnly&&writes.includes(cmd))fail('read-only mode: command would intentionally modify WhatsApp or the local store');
if(cmd==='auth'){fs.mkdirSync(store,{recursive:true,mode:0o700});fs.writeFileSync(session,'{}',{mode:0o600});log({auth:argv,store,phone,env_store:env.WACLI_STORE_DIR});
 emit('auth_starting');emit('warning',{code:'sync_no_limits',message:'no storage limits'});
 let n=0;const decision=path.join(root,'decision.json');
 const show=()=>{if(phone){if(!n++)emit('pair_code',{phone,code:'ABCD-EFGH'});}else emit('qr_code',{code:'2@qr-'+(++n)+',key,adv'});};
 show();const t=setInterval(show,150);
 const wait=()=>{if(!fs.existsSync(decision))return setTimeout(wait,25);const d=JSON.parse(fs.readFileSync(decision,'utf8'));fs.rmSync(decision);clearInterval(t);
  if(d.passkey)fail('WhatsApp requires passkey verification, which wacli cannot safely complete yet');
  fs.writeFileSync(session,JSON.stringify({jid:d.number+'@s.whatsapp.net'}));
  setTimeout(()=>{out({authenticated:true,messages_stored:3});process.exit(0);},600);};wait();
 process.on('SIGTERM',()=>{emit('signal',{signal:'terminated',action:'shutdown'});fail('context canceled');});}
else if(cmd==='auth status'){if(!readOnly)process.exit(9);const s=read();out(s.jid?{authenticated:true,linked_jid:s.jid,phone:s.jid.split('@')[0]}:{authenticated:false});}
else if(cmd==='auth logout'){if(locked())fail('store is locked (another wacli is running?)');log({logout:store,jid:read().jid});fs.writeFileSync(session,'{}');out({logged_out:true});}
else if(cmd==='sync --follow'){if(!read().jid)fail('not authenticated; run \`wacli auth\`');if(locked())fail('store is locked (another wacli is running?)');
 fs.writeFileSync(lock,String(process.pid));log({sync:store,pid:process.pid});
 const stop=()=>{fs.rmSync(lock,{force:true});process.exit(0);};process.on('SIGTERM',stop);
 const crash=path.join(root,'crash');const tick=()=>{if(fs.existsSync(crash)){fs.rmSync(crash);fs.rmSync(lock,{force:true});process.exit(1);}setTimeout(tick,25);};tick();}
else process.exit(9);
`;

// Linking is wacli's own QR (or pairing-code) flow: Link shows the code wacli reports, keeps
// following its changes, and confirms the account before the store becomes the account's. Link
// then keeps \`wacli sync --follow\` running for the account and stops it to remove the account.
test('WhatsApp links by QR or pairing code, keeps wacli sync running, gives agents read-only access and signs out on removal', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'link-wacli-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'wacli'), fixture, { mode: 0o700 });
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LinkService } from ${dist('service.js')}; import { accessSummary } from ${dist('access-summary.js')};
import { accountBrief } from ${dist('brief.js')};
const root=${JSON.stringify(root)}, dir=path.join(root,'link'), owner={kind:'human',id:'fred',name:'Fred'};
let l=new LinkService(dir);
const calls=()=>fs.existsSync(path.join(root,'calls.ndjson'))?fs.readFileSync(path.join(root,'calls.ndjson'),'utf8').trim().split('\\n').map(JSON.parse):[];
const until=async(fn,what)=>{for(let i=0;i<400;i++){const v=await fn();if(v)return v;await sleep(25);}throw Error('timed out: '+what);};
const input=(extra={})=>({provider:'wacli',owner,purpose:{kind:'personal'},permissions:[],...extra});
const link=async(login,d)=>{fs.writeFileSync(path.join(root,'decision.json'),JSON.stringify(d));
 return until(()=>{const s=l.login(login.id,'fred');return !['awaiting_consent','verifying'].includes(s.state)&&s;},'sign-in settles');};
const syncs=(store)=>calls().filter(c=>c.sync===store);

// The QR code is shown and follows wacli's changes; it isn't saved anywhere.
let login=await l.start(input(),'fred');
assert.equal(login.state,'awaiting_consent',login.message);
assert.equal(login.qr,'2@qr-1,key,adv'); assert.equal(login.code,null); assert.match(login.message,/Linked devices/);
const second=await until(()=>{const s=l.login(login.id,'fred');return s.qr!=='2@qr-1,key,adv'&&s;},'QR code changes');
assert.match(second.qr,/^2@qr-[2-9]/);
assert.doesNotMatch(fs.readFileSync(path.join(dir,'accounts.json'),'utf8'),/qr-/);
let done=await link(login,{number:'15551234567'}); assert.equal(done.state,'connected',done.message);
assert.equal(done.qr,null);
const jane=l.registry.get(done.account_id);
assert.equal(jane.provider_id,'15551234567@s.whatsapp.net');
const store=path.join(dir,'accounts',jane.id,'wacli');
assert.ok(fs.existsSync(path.join(store,'session.db')));
assert.deepEqual(fs.readdirSync(path.join(dir,'wacli')),[],'no sign-in store is left behind');
assert.match(accessSummary(jane).note,/read-only/);

// Link keeps wacli sync running for the account (WACLI_READONLY on the host doesn't reach it),
// and starts it again when it exits.
await until(()=>syncs(store).length===1,'sync starts');
assert.equal(l.report().find(a=>a.id===jane.id).sync,'running');
fs.writeFileSync(path.join(root,'crash'),'');
await until(()=>syncs(store).length===2,'sync restarts');
assert.notEqual(syncs(store)[0].pid,syncs(store)[1].pid);

// Agents get the account's store in read-only mode.
const inv=await l.invocation(jane.id);
assert.deepEqual(inv.environment,{WACLI_STORE_DIR:store,WACLI_READONLY:'1'});
assert.equal(inv.command_prefix,"env WACLI_STORE_DIR='"+store+"' WACLI_READONLY=1 '"+path.join(root,'bin','wacli')+"'");
assert.match(accountBrief(l.accounts()),/\\+15551234567 \\| Fred \\| personal \\| read-only/);

// Link starting again starts sync for connected accounts; stopping Link stops it.
l.stop();
await until(()=>!fs.existsSync(path.join(store,'LOCK.pid')),'sync stops with Link');
l=new LinkService(dir); l.resume();
await until(()=>syncs(store).length===3,'sync starts with Link');
await l.check(jane.id); assert.equal(l.registry.get(jane.id).state,'connected');

// With a phone number wacli shows a pairing code instead; cancelling leaves nothing behind.
login=await l.start(input({phone:'+1 (555) 987-6543'}),'fred');
assert.equal(login.code,'ABCD-EFGH'); assert.equal(login.qr,undefined);
assert.equal(calls().filter(c=>c.auth).at(-1).phone,'15559876543');
l.cancel(login.id,'fred');
await until(()=>fs.readdirSync(path.join(dir,'wacli')).length===0,'sign-in store removed');
assert.equal(l.accounts().length,1);

// WhatsApp asking for a passkey ends the sign-in plainly.
login=await l.start(input(),'fred');
const passkey=await link(login,{passkey:true}); assert.equal(passkey.state,'failed'); assert.match(passkey.message,/passkey/);
l.registry.remove(passkey.account_id);

// Reconnecting with a different number changes nothing, and that link is signed out.
login=await l.start(input({account_id:jane.id}),'fred');
const wrong=await link(login,{number:'447700900123'}); assert.equal(wrong.state,'failed');
assert.match(wrong.message,/Link \\+15551234567 to reconnect/);
await until(()=>calls().some(c=>c.jid==='447700900123@s.whatsapp.net'),'the other link is signed out');
assert.equal(JSON.parse(fs.readFileSync(path.join(store,'session.db'),'utf8')).jid,'15551234567@s.whatsapp.net');

// Removing stops sync first (wacli's sign-out needs the store's lock), signs out and deletes
// only this account's store.
await l.check(jane.id);
await until(()=>l.report().find(a=>a.id===jane.id).sync==='running','sync running');
await l.remove(jane.id);
assert.ok(calls().some(c=>c.logout===store&&c.jid==='15551234567@s.whatsapp.net'));
assert.equal(fs.existsSync(store),false); assert.equal(l.accounts().length,0);
const count=syncs(store).length; await sleep(2500); assert.equal(syncs(store).length,count,'sync stays stopped');
l.stop(); console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: path.join(root, 'home'),
				WACLI_READONLY: '1',
				WACLI_STORE_DIR: path.join(root, 'host-store'),
				FIXTURE_ROOT: root,
				PATH: bin + path.delimiter + process.env.PATH
			},
			timeout: 90000
		});
		assert.match(result.stdout, /passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
