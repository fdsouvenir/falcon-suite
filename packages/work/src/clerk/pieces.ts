// Splitting a reply into the pieces a person reads one by one (spec §3.2). Shared by the plugin
// and the evaluation, so both judge exactly the same pieces.

/**
 * Split a reply into the pieces a person answers one by one: sentences and list items, with code
 * removed and markdown emphasis stripped. Each piece keeps the piece before it as context, so
 * "the policy number" under "I need:" can be judged. The evaluation uses the same splitter.
 */
export function segments(reply: string): { text: string; context: string; item: boolean }[] {
	const text = reply.replace(/```[\s\S]*?```/g, '\n').replace(/`([^`]*)`/g, '$1');
	const out: { text: string; context: string; item: boolean }[] = [];
	let previous = '';
	for (const raw of text.split(/\n+/)) {
		const item = /^\s*(?:[-*•]|\d+[.)])\s+/.test(raw);
		const line = raw
			.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
			.replace(/[*_]+/g, '')
			.replace(/^#+\s*/, '')
			.replace(/^>\s*/, '')
			.trim();
		if (!line) continue;
		for (const piece of line.split(/(?<=[.!?。？])\s+(?=[^\s])/)) {
			const t = piece.trim();
			if (t.split(/\s+/).length < 2 && !/[?？]$/.test(t)) continue;
			out.push({ text: t, context: previous, item });
			previous = t;
		}
	}
	return out;
}
