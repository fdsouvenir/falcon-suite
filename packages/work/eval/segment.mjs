// Split an agent reply into the pieces a person would answer one by one: sentences and list
// items, with code removed and markdown emphasis stripped. Each piece keeps the line before it
// as context, so "the policy number" under "I need:" can be judged.
export const normalize = (s) =>
	s
		.replace(/[*_`>#]+/g, '')
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();

// The plugin's own splitter, so the evaluation judges exactly the pieces Work would use.
export { segments } from '../dist/plugin/gates.js';

/** Which gold class a segment carries: need, offer, chat or none. */
export function goldFor(segment, labels) {
	const s = normalize(segment);
	for (const cls of ['need', 'offer', 'chat'])
		for (const span of labels[cls] ?? []) {
			const p = normalize(span);
			if (!p) continue;
			if (s.includes(p) || (p.includes(s) && s.length >= 12)) return cls;
		}
	return 'none';
}
