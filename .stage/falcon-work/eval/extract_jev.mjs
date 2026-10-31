// Run gate asked_for (which pieces of a reply are the asks?) on Jev, for turns that ask the person.
//   JEV_KEY_ENTRY="Services/…" node extract_jev.mjs eval-set.json gate1-gold.json gates.json out.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const [setFile, goldFile, gatesFile, out] = process.argv.slice(2);
const key = execFileSync(
	'keepassxc-cli',
	[
		'show',
		'--no-password',
		'--key-file',
		`${os.homedir()}/.openclaw/vault.key`,
		'-a',
		'password',
		'-q',
		`${os.homedir()}/.openclaw/passwords.kdbx`,
		process.env.JEV_KEY_ENTRY
	],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
).trim();
const gold = JSON.parse(readFileSync(goldFile, 'utf8'));
const template = JSON.parse(readFileSync(gatesFile, 'utf8')).asked_for.piece_template;
const fill = (v, id) => JSON.parse(JSON.stringify(v).replaceAll('{id}', id));
const items = JSON.parse(readFileSync(setFile, 'utf8')).filter((it) =>
	(gold[it.id] ?? ['nothing'])[0].startsWith('needs_')
);
const results = {};
let tokens = 0;
const queue = [...items];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let it; (it = queue.shift());) {
			const pieces = Object.fromEntries(it.segments.map((s, n) => [`p${n + 1}`, s.text]));
			const questions = Object.fromEntries(
				Object.keys(pieces).map((id) => [id, fill(template, id)])
			);
			const res = await fetch('https://api.typesafe.ai/v1/systemone', {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					model: 'jev-1.13.0',
					state: { request: (it.user || '').slice(0, 300), reply: it.reply.slice(-6000), pieces },
					questions
				}),
				signal: AbortSignal.timeout(90000)
			});
			if (!res.ok) throw new Error(`Jev HTTP ${res.status} on ${it.id}`);
			const r = await res.json();
			tokens += r.usage?.input_tokens ?? 0;
			results[it.id] = it.segments.map((_, n) => r.answers[`p${n + 1}`].noul);
		}
	})
);
writeFileSync(out, JSON.stringify({ input_tokens: tokens, items: results }));
console.log(`${items.length} turns, ${tokens} input tokens`);
