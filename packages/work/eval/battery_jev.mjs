// Run the plugin's own end-of-turn battery (dist/plugin/gates.js) over the evaluation set on Jev,
// so the bundled questions can be checked against the same labels as the separate gates.
//   JEV_KEY_ENTRY="Services/…" node battery_jev.mjs eval-set.json out.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { turnBattery } from '../dist/plugin/gates.js';

const [setFile, out] = process.argv.slice(2);
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
// OpenClaw's TypeSafe adapter sends "boolean" questions to Jev as "noul"; do the same.
const toJev = (q) => (q.type === 'boolean' ? { ...q, type: 'noul' } : q);
const RAISED = {
	r027: [
		'What city, state/region, and country is the house in?',
		'Does spring 2027 mean listing or completed closing?'
	]
};
const items = JSON.parse(readFileSync(setFile, 'utf8'));
const turns = {},
	pieces = {},
	shadow = {};
let tokens = 0;
const queue = [...items];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let it; (it = queue.shift());) {
			const { pieceIds, batch } = turnBattery({
				request: it.user || '',
				reply: it.reply,
				task: null,
				tasks: []
			});
			batch.state.raised_in_work = RAISED[it.id] ?? [];
			const res = await fetch('https://api.typesafe.ai/v1/systemone', {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					model: 'jev-1.13.0',
					state: batch.state,
					questions: Object.fromEntries(
						Object.entries(batch.questions).map(([k, q]) => [k, toJev(q)])
					)
				}),
				signal: AbortSignal.timeout(90000)
			});
			if (!res.ok) throw new Error(`Jev HTTP ${res.status} on ${it.id}`);
			const r = await res.json();
			tokens += r.usage?.input_tokens ?? 0;
			const lw = r.answers.left_waiting;
			turns[it.id] = { choice: lw.choice, p: lw.probabilities };
			pieces[it.id] = pieceIds.map((id) => r.answers[id].noul);
			shadow[it.id] = {
				work_request: r.answers.work_request.choice,
				plan_in_chat: r.answers.plan_in_chat.noul,
				promise: r.answers.promise.noul
			};
		}
	})
);
writeFileSync(
	out,
	JSON.stringify({
		'battery/left_waiting': { items: turns },
		pieces: { items: pieces },
		shadow,
		input_tokens: tokens
	})
);
console.log(
	`${items.length} turns, ${tokens} input tokens (${Math.round(tokens / items.length)} per turn)`
);
