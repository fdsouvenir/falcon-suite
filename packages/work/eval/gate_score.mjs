// Score gate left_waiting runs by the Work action they would take.
//   node gate_score.mjs eval-set.json gate1-gold.json gate1.json
// "needs" = needs_answer | needs_decision | needs_action: something lands under the person's Needs you.
import { readFileSync } from 'node:fs';
import { asksThePerson } from '../dist/plugin/asks.js';

const [setFile, goldFile, runFile] = process.argv.slice(2);
const items = JSON.parse(readFileSync(setFile, 'utf8'));
const gold = JSON.parse(readFileSync(goldFile, 'utf8'));
const runs = runFile ? JSON.parse(readFileSync(runFile, 'utf8')) : {};
const G = (id) => gold[id] ?? ['nothing'];
const needs = (o) => o.startsWith('needs_');

function score(name, predict, threshold) {
	let tp = 0,
		fp = 0,
		fn = 0,
		right = 0,
		n = 0;
	const errors = [];
	for (const it of items) {
		let { choice, conf } = predict(it);
		if (threshold && needs(choice) && conf < threshold) choice = 'nothing';
		const g = G(it.id);
		const gNeeds = needs(g[0]);
		if (gNeeds && needs(choice)) tp++;
		else if (!gNeeds && needs(choice)) {
			fp++;
			errors.push(`FP ${it.id} → ${choice}`);
		} else if (gNeeds && !needs(choice)) {
			fn++;
			errors.push(`FN ${it.id} (${g[0]}) → ${choice}`);
		}
		if (g.includes(choice) || (!gNeeds && !needs(choice))) right++;
		n++;
	}
	const p = tp / (tp + fp || 1),
		r = tp / (tp + fn || 1);
	return { name, p, r, f1: (2 * p * r) / (p + r || 1), acc: right / n, tp, fp, fn, errors };
}

const rows = [
	score('text match (current)', (it) => ({
		choice: asksThePerson(it.reply) ? 'needs_answer' : 'nothing',
		conf: 1
	}))
];
for (const [key, run] of Object.entries(runs))
	for (const t of [0, 0.4, 0.5, 0.6])
		rows.push(
			score(
				`laya ${key}${t ? ` needs≥${t}` : ''}`,
				(it) => {
					const r = run.items[it.id];
					return { choice: r.choice, conf: r.p[r.choice] };
				},
				t
			)
		);
rows.sort((a, b) => b.f1 - a.f1);
console.log(
	'needs = something lands under Needs you. P: how often it is real. R: how much real is caught. Action: right outcome per turn.\n'
);
for (const m of rows)
	console.log(
		`${m.name.padEnd(48)} P ${m.p.toFixed(2)}  R ${m.r.toFixed(2)}  F1 ${m.f1.toFixed(2)}  action ${m.acc.toFixed(2)}  (fp ${m.fp} fn ${m.fn})`
	);
if (process.env.SHOW)
	for (const m of rows.filter((r) => r.name.includes(process.env.SHOW)))
		console.log(`\n${m.name}\n  ${m.errors.join('\n  ')}`);
