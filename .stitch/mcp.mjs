// Minimal Stitch MCP client over streamable HTTP. Key read from KeePassXC, never printed.
//   node mcp.mjs <method> [jsonParams]      e.g. tools/list   or   tools/call '{"name":..,"arguments":{..}}'
import { execFileSync } from 'node:child_process';
import os from 'node:os';
const home = os.homedir();
const key = execFileSync('keepassxc-cli', ['show', '--no-password', '--key-file', `${home}/.openclaw/vault.key`, '-a', 'password', '-q', `${home}/.openclaw/passwords.kdbx`, 'Services/APIs/Stitch MCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const URL_ = 'https://stitch.googleapis.com/mcp';
let sid = null, n = 0;
async function rpc(method, params, notify = false) {
	const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++n }) };
	const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Goog-Api-Key': key, ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
	sid = res.headers.get('mcp-session-id') ?? sid;
	const text = await res.text();
	if (notify) return null;
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
	const line = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() : text;
	return JSON.parse(line);
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verl', version: '1' } });
await rpc('notifications/initialized', undefined, true);
const [method, p] = process.argv.slice(2);
const out = await rpc(method, p ? JSON.parse(p) : {});
console.log(JSON.stringify(out, null, 1));
