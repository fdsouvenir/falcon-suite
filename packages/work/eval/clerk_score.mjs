// Score clerk_jev.mjs answers against the gold labels, question by question and as the actions
// spec §3.3 would take.
//   node clerk_score.mjs <labels-dir> <answers.json> [--include-unclear]
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { YES, NO } from '../dist/clerk/questions.js';

const [labelsDir, answersFile, flag] = process.argv.slice(2);
const answers = JSON.parse(readFileSync(answersFile, 'utf8'));
const labels = {};
for (const f of readdirSync(labelsDir).filter((f) => f.endsWith('.json')))
	labels[f] = JSON.parse(readFileSync(path.join(labelsDir, f), 'utf8'));

const stats = {};
const add = (q, gold, p) => {
	const s = (stats[q] ??= { tp: 0, fp: 0, fn: 0, tn: 0, unsettledYes: 0, unsettledNo: 0, n: 0 });
	s.n++;
	if (p >= YES) gold ? s.tp++ : s.fp++;
	else if (p <= NO) gold ? s.fn++ : s.tn++;
	else gold ? s.unsettledYes++ : s.unsettledNo++;
};
const act = {
	filedRight: 0,
	filedWrong: 0,
	filedMissed: 0,
	newRight: 0,
	newWrong: 0,
	newMissed: 0,
	raisedRight: 0,
	raisedWrong: 0,
	raisedMissed: 0,
	statusPicked: 0,
	statusPickedRight: 0,
	toWriter: 0,
	turns: 0
};

let skipped = 0;
for (const [id, a] of Object.entries(answers)) {
	const L = labels[a.session];
	const g = L?.turns?.[id];
	if (!g) continue;
	if (g.unclear && flag !== '--include-unclear') {
		skipped++;
		continue;
	}
	act.turns++;
	const A = a.answers;
	for (const q of [
		'work_asked',
		'work_reported',
		'work_planned',
		'needs_person',
		'waits_outside',
		'only_conversation'
	])
		if (A[q] !== undefined) add(q, !!g[q], A[q]);
	if (A.any_item !== undefined)
		add(
			'any_item',
			g.items.some((k) => a.candidates.some((c) => c.key === k)),
			A.any_item
		);
	if (A.new_work !== undefined)
		add(
			'new_work',
			g.items.some((k) => !a.candidates.some((c) => c.key === k)) && !!g.work_asked,
			A.new_work
		);
	const yesAbout = [];
	let unsettledAbout = false;
	for (const c of a.candidates) {
		const own = !c.key.startsWith('x:');
		add(
			own ? 'about (own items)' : 'about (decoys)',
			own && g.items.includes(c.key),
			A[`about.${c.slot}`]
		);
		if (own) add('done', g.done.includes(c.key), A[`done.${c.slot}`]);
		if (A[`about.${c.slot}`] >= YES) yesAbout.push(c.key);
		else if (A[`about.${c.slot}`] > NO) unsettledAbout = true;
	}
	const pieces = Object.keys(A)
		.filter((k) => k.startsWith('stands.'))
		.map((k) => k.slice(7));
	const n = pieces.length;
	// Pieces are keyed p1..pN over the last 40; gold indexes are 0-based over the packet's pieces (≤40).
	for (const p of pieces) {
		const idx = Number(p.slice(1)) - 1;
		add('stands', g.stands.includes(idx), A[`stands.${p}`]);
		if (g.needs_person) add('asks (needs_person turns)', g.asks.includes(idx), A[`asks.${p}`]);
	}
	// Actions (spec §3.3).
	const anyItem = A.any_item;
	const files = anyItem >= YES && yesAbout.length > 0;
	const goldExisting = g.items.filter((k) => a.candidates.some((c) => c.key === k));
	if (files) {
		const right = yesAbout.every((k) => g.items.includes(k));
		right ? act.filedRight++ : act.filedWrong++;
	} else if (goldExisting.length) act.filedMissed++;
	const asked = A.work_asked >= YES || A.work_reported >= YES;
	const ownSlots = a.candidates.filter((c) => !c.key.startsWith('x:')).map((c) => c.slot);
	const allSlots = a.candidates.map((c) => c.slot);
	const noneFits = allSlots.every((sl) => (A[`about.${sl}`] ?? 0) <= NO);
	const isNew = asked && (A.new_work >= YES || noneFits);
	void ownSlots;
	const ownKeys = a.candidates.filter((c) => !c.key.startsWith('x:')).map((c) => c.key);
	const goldNewWork = g.items.some((k) => !ownKeys.includes(k));
	if (isNew) goldNewWork ? act.newRight++ : act.newWrong++;
	else if (goldNewWork) act.newMissed++;
	// Spec §3.3: Needs you is raised only when the turn's work is an item (filed or new).
	const raised = A.needs_person >= YES && (files || isNew);
	if (raised) g.needs_person ? act.raisedRight++ : act.raisedWrong++;
	else if (g.needs_person) act.raisedMissed++;
	const best = pieces
		.map((p) => [Number(p.slice(1)) - 1, A[`stands.${p}`]])
		.sort((x, y) => y[1] - x[1])[0];
	if (best && best[1] >= YES) {
		act.statusPicked++;
		if (g.stands.includes(best[0])) act.statusPickedRight++;
	}
	const unsettled =
		[A.work_asked, A.work_reported].some((p) => p !== undefined && p > NO && p < YES) ||
		unsettledAbout;
	if (unsettled || isNew || A.work_planned >= YES) act.toWriter++;
	void n;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—');
console.log(`turns scored: ${act.turns} (unclear skipped: ${skipped})\n`);
console.log(
	'question'.padEnd(28),
	'n'.padStart(5),
	'prec'.padStart(6),
	'recall'.padStart(7),
	'settled-acc'.padStart(12),
	'unsettled'.padStart(10)
);
for (const [q, s] of Object.entries(stats)) {
	const settled = s.tp + s.fp + s.fn + s.tn;
	console.log(
		q.padEnd(28),
		String(s.n).padStart(5),
		pct(s.tp, s.tp + s.fp).padStart(6),
		pct(s.tp, s.tp + s.fn + s.unsettledYes).padStart(7),
		pct(s.tp + s.tn, settled).padStart(12),
		pct(s.unsettledYes + s.unsettledNo, s.n).padStart(10)
	);
}
console.log('\nactions (spec §3.3):');
console.log(
	`  filed under an item: ${act.filedRight} right, ${act.filedWrong} wrong; turns with gold items not filed: ${act.filedMissed}`
);
console.log(
	`  new work detected: ${act.newRight} right, ${act.newWrong} wrong, ${act.newMissed} missed`
);
console.log(
	`  Needs you raised: ${act.raisedRight} right, ${act.raisedWrong} wrong, ${act.raisedMissed} missed`
);
console.log(
	`  status line picked: ${act.statusPicked}, of which a gold "stands" piece: ${act.statusPickedRight} (${pct(act.statusPickedRight, act.statusPicked)})`
);
console.log(
	`  turns sent to the writer: ${act.toWriter} of ${act.turns} (${pct(act.toWriter, act.turns)})`
);
