// Score question detectors against the evaluation set.
//   node score.mjs eval-set.json [predictions.json] [predictions-v2.json]
// Reply level: does the reply ask the person for something they must supply (gold: any "need")?
// Segment level: which pieces are those needs (offers and chat count as "not a need")?
import { readFileSync } from 'node:fs';
import { asksThePerson } from '../dist/plugin/asks.js';

const [setFile, predFile] = process.argv.slice(2);
const items = JSON.parse(readFileSync(setFile, 'utf8'));
const preds = predFile ? JSON.parse(readFileSync(predFile, 'utf8')) : {};

const REQUEST =
	/\b(send me|tell me|let me know|reply with|get back to me|could you|can you|would you|do you (want|prefer|have)|which (one|option|do you)|please (share|confirm|send|provide|choose|pick|tell)|i need (you|from you|to know)|confirm (whether|which|that|the))\b/i;
const regexSegment = (s) => /[?？]\s*$/.test(s.text) || REQUEST.test(s.text);

function prf(pairs) {
	let tp = 0, fp = 0, fn = 0, tn = 0;
	for (const [gold, pred] of pairs) {
		if (gold && pred) tp++;
		else if (!gold && pred) fp++;
		else if (gold && !pred) fn++;
		else tn++;
	}
	const p = tp / (tp + fp || 1), r = tp / (tp + fn || 1);
	return { p, r, f1: (2 * p * r) / (p + r || 1), tp, fp, fn, tn };
}
const fmt = (m) =>
	`P ${m.p.toFixed(2)}  R ${m.r.toFixed(2)}  F1 ${m.f1.toFixed(2)}  (tp ${m.tp} fp ${m.fp} fn ${m.fn})`;

const rows = [];
const reply = (name, predict) =>
	rows.push(['reply', name, prf(items.map((it) => [it.gold, predict(it)]))]);
const segment = (name, predict) =>
	rows.push([
		'segment',
		name,
		prf(items.flatMap((it) => it.segments.map((s, n) => [s.gold === 'need', predict(it, s, n)])))
	]);

reply('text match (current)', (it) => asksThePerson(it.reply));
segment('text match', (_it, s) => regexSegment(s));

const extra = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], 'utf8')) : {};
for (const [model, run] of Object.entries(extra)) {
	const P = (it) => run.items[it.id];
	for (const t of [0.5, 0.7, 0.8, 0.9]) {
		segment(`laya ${model} request-vs-statement ≥${t}`, (it, _s, n) => P(it).segments[n].request >= t);
		reply(`laya ${model} any request-vs-statement ≥${t}`, (it) =>
			Object.values(P(it).segments).some((x) => x.request >= t)
		);
	}
	console.log(`${model} (choice): ${run.requests} requests, ${Math.round(run.seconds)} s`);
}

for (const [model, run] of Object.entries(preds)) {
	const P = (it) => run.items[it.id];
	for (const t of [0.3, 0.5, 0.7]) reply(`laya ${model} reply question ≥${t}`, (it) => P(it).reply >= t);
	for (const q of ['ask_a', 'ask_b'])
		for (const t of [0.3, 0.5, 0.7]) {
			segment(`laya ${model} ${q} ≥${t}`, (it, _s, n) => P(it).segments[n][q] >= t);
			reply(`laya ${model} any segment ${q} ≥${t}`, (it) =>
				Object.values(P(it).segments).some((x) => x[q] >= t)
			);
		}
	segment(`laya ${model} kind = need`, (it, _s, n) => P(it).segments[n].kind === 'need');
	console.log(`${model}: ${run.requests} requests, ${Math.round(run.seconds)} s`);
}

for (const level of ['reply', 'segment']) {
	console.log(`\n${level.toUpperCase()} LEVEL`);
	for (const [l, name, m] of rows.filter((r) => r[0] === level).sort((a, b) => b[2].f1 - a[2].f1))
		console.log(`${name.padEnd(44)} ${fmt(m)}`);
}
