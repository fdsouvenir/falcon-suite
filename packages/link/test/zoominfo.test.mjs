import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const dist = (file) => JSON.stringify(new URL(`../dist/${file}`, import.meta.url).href);

// A stand-in for gtm 2.2.1 (src/oauth.ts, src/credentials.ts, src/commands/auth.ts): `auth login`
// listens on 127.0.0.1:9876 for GET /callback, tries xdg-open and otherwise prints the address,
// checks state, and saves ~/.config/gtm-ai/credentials; `auth whoami` reads the token's name.
const fixture = `#!${process.execPath}
import fs from 'node:fs';import http from 'node:http';import path from 'node:path';import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2),store=path.join(process.env.HOME,'.config','gtm-ai'),file=path.join(store,'credentials');
if(a[0]==='--version'){console.log('2.2.1');process.exit();}
const jwt=(user)=>['x',Buffer.from(JSON.stringify({firstName:'Ada',lastName:'Lovelace',ziUsername:user})).toString('base64url'),'y'].join('.');
if(a.join(' ')==='auth whoami'){let c=null;try{c=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 if(!c){console.error('No valid user found.');process.exit(1);}
 const p=JSON.parse(Buffer.from(c.access_token.split('.')[1],'base64url'));console.log('Logged in as '+p.firstName+' '+p.lastName+' ('+p.ziUsername+')');process.exit();}
if(a.join(' ')==='auth login'){const state='s'+process.pid;
 const url='https://mcp.zoominfo.com/oauth/authorize?client_id=c&redirect_uri='+encodeURIComponent('http://localhost:9876/callback')+'&response_type=code&scope=openid&code_challenge=x&code_challenge_method=S256&state='+state;
 const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost:9876');res.end('done');
  const fail=m=>server.close(()=>{console.error('Error: '+m);process.exit(1);});
  if(u.searchParams.get('error'))return fail('Authorization denied');
  if(u.searchParams.get('state')!==state)return fail('State mismatch — possible CSRF attack');
  fs.mkdirSync(store,{recursive:true});fs.writeFileSync(file,JSON.stringify({type:'oauth',access_token:jwt(u.searchParams.get('code')),refresh_token:'r',client_id:'c',expires_at:null}));
  server.close(()=>{console.log('Logged in.');process.exit();});});
 server.on('error',e=>{console.error('Error: '+e.message);process.exit(1);});
 server.listen(9876,'127.0.0.1',()=>{console.log('Opening browser for ZoomInfo login...');const r=spawnSync('xdg-open',[url]);
  if(r.error||r.status!==0)console.log('\\nCould not open browser automatically. Visit:\\n'+url+'\\n');console.log('Waiting for authorization...');});
} else process.exit(9);
`;

// The person copies the unreachable localhost address back; Link forwards it to the waiting gtm.
test('ZoomInfo sign-in forwards the pasted localhost address to gtm, never opens a desktop browser, and keeps one account', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'link-zoominfo-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'gtm'), fixture, { mode: 0o700 });
		// The Office's desktop opener; it must never run.
		await writeFile(path.join(bin, 'xdg-open'), `#!/bin/sh\ntouch "${root}/opened"\n`, {
			mode: 0o700
		});
		const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
import { LinkService } from ${dist('service.js')};
const root=${JSON.stringify(root)}, dir=path.join(root,'link'), l=new LinkService(dir), owner={kind:'human',id:'fred',name:'Fred'};
const input={provider:'zoominfo',owner,purpose:{kind:'work'},permissions:[]};
const back=(login,query)=>'copied: localhost:9876/callback?'+query+'&state='+new URL(login.url).searchParams.get('state')+' (end)';
let login=await l.start(input,'fred'); assert.equal(login.state,'awaiting_consent',login.message); assert.equal(new URL(login.url).hostname,'mcp.zoominfo.com');
assert.equal(fs.existsSync(path.join(root,'opened')),false,'no browser opens on the Office');
await assert.rejects(()=>l.finish(login.id,'https://example.com/callback?code=x','fred'),/starts with http:\\/\\/localhost:9876\\/callback/);
const declined=await l.finish(login.id,back(login,'error=access_denied'),'fred'); assert.equal(declined.state,'cancelled'); assert.match(declined.message,/Nothing changed/);
assert.equal(l.accounts().length,0);
login=await l.start(input,'fred');
const wrong=await l.finish(login.id,'http://127.0.0.1:9876/callback?code=ada@example.com&state=other','fred');
assert.equal(wrong.state,'failed'); assert.match(wrong.message,/different ZoomInfo sign-in/);
assert.doesNotMatch(fs.readFileSync(path.join(dir,'accounts.json'),'utf8'),/ada@example.com/,'the pasted address is never saved');
login=await l.start({...input,account_id:wrong.account_id},'fred');
const done=await l.finish(login.id,back(login,'code=ada@example.com'),'fred'); assert.equal(done.state,'connected',done.message);
const a=l.registry.get(done.account_id); assert.equal(a.display_name,'Ada Lovelace'); assert.equal(a.provider_id,'ada@example.com');
await assert.rejects(()=>l.start(input,'fred'),/one account per Office/);
await l.discover(); assert.equal(l.accounts().length,1,'the Link account owns gtm\\'s store');
login=await l.start({...input,account_id:a.id},'fred');
const other=await l.finish(login.id,back(login,'code=bob@example.com'),'fred'); assert.equal(other.state,'failed'); assert.match(other.message,/not ada@example.com/);
const saved=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.config/gtm-ai/credentials'),'utf8'));
assert.equal(JSON.parse(Buffer.from(saved.access_token.split('.')[1],'base64url')).ziUsername,'ada@example.com','the earlier sign-in is put back');
const busy=net.createServer().listen(9876,'127.0.0.1'); await new Promise(r=>busy.on('listening',r));
const blocked=await l.start({...input,account_id:a.id},'fred'); assert.equal(blocked.state,'failed'); assert.match(blocked.message,/port 9876/);
busy.close(); l.stop(); console.log('passed');`;
		const result = await run(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: path.join(root, 'home'),
				PATH: bin + path.delimiter + process.env.PATH
			},
			timeout: 30000
		});
		assert.match(result.stdout, /passed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
