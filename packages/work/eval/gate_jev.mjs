// Run a Falcon Work gate over the evaluation set with hosted Jev (TypeSafe System One API).
//   JEV_KEY_ENTRY="Services/…" node gate_jev.mjs eval-set.json gates.json out.json
// The API key is read from KeePassXC and never printed. Same output shape as gate_run.py.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const MODEL = 'jev-1.13.0';
const [setFile, gatesFile, out] = process.argv.slice(2);
const entry = process.env.JEV_KEY_ENTRY;
if (!entry) throw new Error('Set JEV_KEY_ENTRY to the vault entry holding the Jev API key');
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
		entry
	],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
).trim();

// Turns where the agent had already recorded its questions in Work.
const RAISED = {
	r027: [
		'What city, state/region, and country is the house in?',
		'Does spring 2027 mean listing or completed closing? Any firm move-out deadline?'
	]
};
const items = JSON.parse(readFileSync(setFile, 'utf8'));
const gate = JSON.parse(readFileSync(gatesFile, 'utf8')).left_waiting;
const variants = { full: gate.question, compact: gate.compact };
const stateFor = (it) => ({
	request: (it.user || '').slice(0, 300),
	raised_in_work: RAISED[it.id] ?? [],
	task_in_progress: null,
	reply: it.reply.slice(-6000)
});

async function ask(state, question) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await fetch('https://api.typesafe.ai/v1/systemone', {
			method: 'POST',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: MODEL, state, questions: { gate: question } }),
			signal: AbortSignal.timeout(60000)
		});
		if (res.ok) return res.json();
		const status = res.status;
		await res.body?.cancel();
		if (status !== 429 && status < 500) throw new Error(`Jev HTTP ${status}`);
		await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
	}
	throw new Error('Jev unavailable after retries');
}

const results = {};
for (const [vname, question] of Object.entries(variants)) {
	const t0 = Date.now();
	const out_ = {};
	let usage = 0;
	const queue = [...items];
	await Promise.all(
		Array.from({ length: 4 }, async () => {
			for (let it; (it = queue.shift());) {
				const r = await ask(stateFor(it), question);
				const a = r.answers.gate;
				out_[it.id] = { choice: a.choice, p: a.probabilities };
				usage += r.usage?.input_tokens ?? 0;
			}
		})
	);
	const secs = (Date.now() - t0) / 1000;
	results[`jev/${vname}`] = { seconds: secs, input_tokens: usage, items: out_ };
	console.log(`jev/${vname}: ${items.length} turns in ${secs.toFixed(0)}s, ${usage} input tokens`);
	writeFileSync(out, JSON.stringify(results));
}
