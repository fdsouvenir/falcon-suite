// Score gate answers_open_item: per open Question (answered or not) and per open Decision (option).
//   node gate2_score.mjs gate2-set.json gate2-jev.json
import { readFileSync } from 'node:fs';
const [setFile, runFile] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(setFile, 'utf8'));
const run = JSON.parse(readFileSync(runFile, 'utf8')).items;
for (const t of [0.3, 0.4, 0.5, 0.7]) {
	let tp = 0,
		fp = 0,
		fn = 0,
		dRight = 0,
		dN = 0,
		decoyHits = 0;
	const errors = [];
	for (const c of cases)
		for (const o of c.open) {
			const a = run[c.id][o.id];
			if (o.kind === 'question') {
				const gold = c.gold.includes(o.id),
					pred = a.yes >= t;
				if (gold && pred) tp++;
				else if (!gold && pred) {
					fp++;
					if (o.decoy) decoyHits++;
					errors.push(`FP ${c.id}/${o.id}${o.decoy ? ' (decoy)' : ''} ${a.yes.toFixed(2)}`);
				} else if (gold && !pred) {
					fn++;
					errors.push(`FN ${c.id}/${o.id} ${a.yes.toFixed(2)}`);
				}
			} else {
				dN++;
				const want = c.decided[o.id] ?? 'not_decided';
				if (a.choice === want) dRight++;
				else errors.push(`D ${c.id}/${o.id} want ${want} got ${a.choice}`);
			}
		}
	const p = tp / (tp + fp || 1),
		r = tp / (tp + fn || 1);
	console.log(
		`Questions ≥${t}: P ${p.toFixed(2)} R ${r.toFixed(2)} F1 ${((2 * p * r) / (p + r || 1)).toFixed(2)} (tp ${tp} fp ${fp}, ${decoyHits} on decoys, fn ${fn})   Decisions right ${dRight}/${dN}`
	);
	if (process.env.SHOW == String(t)) console.log('  ' + errors.join('\n  '));
}
