// Score extraction (which pieces are the asks?) on turns that ask the person.
//   node extract_score.mjs eval-set.json gate1-gold.json [extract-jev.json]
import { readFileSync } from 'node:fs';
import { askingPart, segments } from '../dist/plugin/gates.js';
import { normalize } from './segment.mjs';

const [setFile, goldFile, jevFile] = process.argv.slice(2);
const gold = JSON.parse(readFileSync(goldFile, 'utf8'));
const items = JSON.parse(readFileSync(setFile, 'utf8')).filter((it) =>
	(gold[it.id] ?? ['nothing'])[0].startsWith('needs_')
);
const jev = jevFile ? JSON.parse(readFileSync(jevFile, 'utf8')).items : null;
function score(name, pick) {
	let tp = 0,
		fp = 0,
		fn = 0,
		exact = 0;
	for (const it of items) {
		let allRight = true;
		it.segments.forEach((s, n) => {
			const g = s.gold === 'need',
				p = pick(it, s, n);
			if (g && p) tp++;
			else if (!g && p) {
				fp++;
				allRight = false;
			} else if (g && !p) {
				fn++;
				allRight = false;
			}
		});
		if (allRight) exact++;
	}
	const P = tp / (tp + fp || 1),
		R = tp / (tp + fn || 1);
	console.log(
		`${name.padEnd(34)} P ${P.toFixed(2)}  R ${R.toFixed(2)}  F1 ${((2 * P * R) / (P + R || 1)).toFixed(2)}  whole turn right ${exact}/${items.length}`
	);
}
// The text extractor: a piece is picked if its text is one of the lines askingPart returns.
score('text (sentence-based askingPart)', (it, s) => {
	const picked = new Set(askingPart(it.reply).split('\n').map(normalize));
	return picked.has(normalize(s.text));
});
if (jev)
	for (const t of [0.5, 0.7, 0.8, 0.9])
		score(`jev asked_for ≥${t}`, (it, _s, n) => jev[it.id][n] >= t);
console.log(
	`(${items.length} turns that ask the person; ${items.reduce((a, it) => a + it.segments.length, 0)} pieces)`
);
void segments;
