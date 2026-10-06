/**
 * Does the agent's final reply ask the person for something (spec §10)? A question to them, or a
 * request for information or a choice ("send me…", "let me know…"). Code is ignored; only the end
 * of the reply counts, where agents put what they need. A guess: a false positive costs one extra
 * pass, which the agent can decline.
 */
const REQUEST =
	/\b(send me|tell me|let me know|reply with|get back to me|could you|can you|would you|do you (want|prefer|have)|which (one|option|do you)|please (share|confirm|send|provide|choose|pick|tell)|i need (you|from you|to know)|confirm (whether|which|that|the))\b/i;

export function asksThePerson(reply: string | undefined | null): boolean {
	if (!reply) return false;
	const text = reply
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/[*_]+/g, '')
		.trim();
	const tail = text.slice(-1200);
	const sentences = tail.split(/(?<=[.!?:])\s+|\n+/).map((s) => s.trim());
	return sentences.some((s) => /\?\s*$/.test(s) || REQUEST.test(s));
}
