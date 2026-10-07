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

export function segments(reply) {
	const text = reply.replace(/```[\s\S]*?```/g, '\n').replace(/`([^`]*)`/g, '$1');
	const out = [];
	let previous = '';
	for (const raw of text.split(/\n+/)) {
		const line = raw
			.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
			.replace(/[*_]+/g, '')
			.replace(/^#+\s*/, '')
			.replace(/^>\s*/, '')
			.trim();
		if (!line) continue;
		for (const s of line.split(/(?<=[.!?。？])\s+(?=[^\s])/)) {
			const t = s.trim();
			if (t.split(/\s+/).length < 2 && !/[?？]$/.test(t)) continue;
			out.push({ text: t, context: previous });
			previous = t;
		}
	}
	return out;
}

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
