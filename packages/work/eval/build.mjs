// Build the evaluation set: replies with their segments and gold labels.
//   node build.mjs <unlabelled.json> <labels-dir> <out.json>
// Real replies come from a private corpus; synthetic.json (in this folder) is always included.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { segments, goldFor } from './segment.mjs';

const [corpusFile, labelsDir, out] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const labels = {};
if (labelsDir)
	for (const f of readdirSync(labelsDir).filter((f) => /^labels-.*\.json$/.test(f)))
		Object.assign(labels, JSON.parse(readFileSync(path.join(labelsDir, f), 'utf8')));
const real = corpusFile ? JSON.parse(readFileSync(corpusFile, 'utf8')) : [];
const synthetic = JSON.parse(readFileSync(path.join(here, 'synthetic.json'), 'utf8'));

const items = [];
for (const r of real) {
	const l = labels[r.id];
	if (!l) throw new Error(`no label for ${r.id}`);
	items.push({ id: r.id, source: r.source, reply: r.reply, labels: l });
}
for (const s of synthetic) items.push({ id: s.id, source: 'synthetic', reply: s.reply, labels: s });

for (const it of items) {
	it.segments = segments(it.reply).map((s) => ({ ...s, gold: goldFor(s.text, it.labels) }));
	it.gold = (it.labels.need ?? []).length > 0;
	if (it.gold && !it.segments.some((s) => s.gold === 'need'))
		console.error(`warning: ${it.id}: no segment matched its need spans`);
}
writeFileSync(out, JSON.stringify(items, null, 1));
const segs = items.flatMap((i) => i.segments);
console.log(
	`${items.length} replies (${items.filter((i) => i.gold).length} ask the person), ${segs.length} segments: ` +
		['need', 'offer', 'chat', 'none'].map((c) => `${c} ${segs.filter((s) => s.gold === c).length}`).join(', ')
);
