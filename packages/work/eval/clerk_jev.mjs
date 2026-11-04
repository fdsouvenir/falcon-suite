// Run the clerk's end-of-turn questions (src/clerk/questions.ts) over labelled real turns with
// hosted Jev, and save every answer for clerk_score.mjs.
//   JEV_KEY_ENTRY="AI Providers/…" node clerk_jev.mjs <packets-dir> <labels-dir> <out.json> [model]
// Packets and labels are private (real sessions) and are never committed. The API key is read from
// KeePassXC and never printed. Each turn is one request, exactly as the plugin would send it.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { turnBatch } from '../dist/clerk/questions.js';

const [packetsDir, labelsDir, out, model = 'jev-1.13.0'] = process.argv.slice(2);
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

/** The runtime's boolean questions are the API's Nouls. */
const toApi = (questions) =>
	Object.fromEntries(
		Object.entries(questions).map(([k, q]) => [
			k,
			q.type === 'boolean' ? { ...q, type: 'noul' } : q
		])
	);

async function evaluate(state, questions) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch('https://api.typesafe.ai/v1/systemone', {
			method: 'POST',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model, state, questions: toApi(questions) }),
			signal: AbortSignal.timeout(90000)
		});
		if (res.ok) return res.json();
		const status = res.status;
		const body = await res.text();
		if (status !== 429 && status < 500)
			throw new Error(`Jev HTTP ${status}: ${body.slice(0, 300)}`);
		await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
	}
	throw new Error('Jev unavailable after retries');
}

// Every session's labelled items are its candidates, plus two items from other sessions as decoys.
const sessions = readdirSync(labelsDir)
	.filter((f) => f.endsWith('.json') && existsSync(path.join(packetsDir, f)))
	.map((f) => ({
		f,
		packet: JSON.parse(readFileSync(path.join(packetsDir, f), 'utf8')),
		labels: JSON.parse(readFileSync(path.join(labelsDir, f), 'utf8'))
	}));
const allItems = sessions.flatMap((s) => s.labels.items.map((it) => ({ ...it, from: s.f })));
const results = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
// The same exchange can appear under several sessions (forks, rollovers): judge it once.
const seenTurns = new Set();
let n = 0;
for (const s of sessions) {
	const decoys = allItems
		.filter((it) => it.from !== s.f)
		.sort((a, b) => (a.title + s.f).localeCompare(b.title + s.f))
		.slice(0, 2);
	// A turn's own candidates are the items earlier turns worked on, as if the record were perfect
	// so far; work first seen in this turn is new work. Decoys go first so a candidate's position
	// says nothing about whether it is the right one.
	const seen = new Set();
	const finished = new Set();
	let previous = null;
	for (const t of s.packet.turns) {
		// Items finished in earlier turns are closed, so they are no longer candidates.
		const own = s.labels.items.filter((it) => seen.has(it.key) && !finished.has(it.key));
		for (const k of s.labels.turns[t.id]?.items ?? []) seen.add(k);
		const prev = previous;
		previous = { request: t.request, reply: t.reply };
		const cands = [...decoys.map((d) => ({ ...d, key: `x:${d.key}:${d.from}` })), ...own];
		const sig = `${t.request.slice(0, 500)}\u0000${t.reply.slice(-500)}`;
		const doneNow = s.labels.turns[t.id]?.done ?? [];
		if (seenTurns.has(sig)) {
			for (const k of doneNow) finished.add(k);
			continue;
		}
		seenTurns.add(sig);
		if (results[t.id]) continue;
		for (const k of doneNow) finished.add(k);
		const batch = turnBatch({
			previous: prev,
			request: t.request,
			reply: t.reply,
			outcomes: [],
			pieces: t.pieces,
			candidates: cands.map((c) => ({
				title: c.title,
				kind: c.kind,
				status: 'open',
				done_when: c.done_when
			})),
			open: []
		});
		const t0 = Date.now();
		const res = await evaluate(batch.state, batch.questions);
		results[t.id] = {
			session: s.f,
			model: res.model,
			ms: Date.now() - t0,
			candidates: cands.map((c, i) => ({ slot: `c${i + 1}`, key: c.key })),
			answers: Object.fromEntries(
				Object.entries(res.answers).map(([k, a]) => [k, a.noul ?? a.probabilities ?? a])
			)
		};
		writeFileSync(out, JSON.stringify(results, null, 1));
		if (++n % 10 === 0) console.log(`${n} turns`);
	}
}
console.log(`done: ${Object.keys(results).length} turns in ${out}`);
