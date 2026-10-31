// Run gate answers_open_item over the gate-2 set with hosted Jev.
//   JEV_KEY_ENTRY="Services/…" node gate2_jev.mjs gate2-set.json gates.json out.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const MODEL = 'jev-1.13.0';
const [setFile, gatesFile, out] = process.argv.slice(2);
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
const gate = JSON.parse(readFileSync(gatesFile, 'utf8')).answers_open_item;
const fill = (v, id) => JSON.parse(JSON.stringify(v).replaceAll('{id}', id));

function request(c) {
	const open_items = {};
	const questions = {};
	for (const [n, o] of c.open.entries()) {
		if (o.kind === 'question') {
			open_items[o.id] = { n: n + 1, prompt: o.prompt };
			questions[o.id] = fill(gate.question_template, o.id);
		} else {
			open_items[o.id] = {
				n: n + 1,
				prompt: o.prompt,
				options: o.options,
				recommendation: o.recommendation
			};
			const q = fill(gate.decision_template, o.id);
			questions[o.id] = {
				type: 'choice',
				instructions: q.instructions,
				criteria: { ...o.options, ...q.criteria_extra }
			};
		}
	}
	return {
		model: MODEL,
		state: {
			previous_reply: (c.previous_reply ?? '').slice(-2000),
			message: c.message,
			open_items
		},
		questions
	};
}

const cases = JSON.parse(readFileSync(setFile, 'utf8'));
const results = {};
let tokens = 0;
const t0 = Date.now();
const queue = [...cases];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let c; (c = queue.shift());) {
			const res = await fetch('https://api.typesafe.ai/v1/systemone', {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify(request(c)),
				signal: AbortSignal.timeout(60000)
			});
			if (!res.ok) throw new Error(`Jev HTTP ${res.status} on ${c.id}`);
			const r = await res.json();
			tokens += r.usage?.input_tokens ?? 0;
			results[c.id] = Object.fromEntries(
				Object.entries(r.answers).map(([id, a]) => [
					id,
					a.type === 'noul' ? { yes: a.noul } : { choice: a.choice, p: a.probabilities }
				])
			);
		}
	})
);
writeFileSync(
	out,
	JSON.stringify({ seconds: (Date.now() - t0) / 1000, input_tokens: tokens, items: results })
);
console.log(
	`${cases.length} messages in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${tokens} input tokens`
);
