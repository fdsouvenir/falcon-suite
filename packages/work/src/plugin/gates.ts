/**
 * Decision gates (spec §10): small typed judgments Work asks the Office's decision model for, each
 * tied to one Work action. Rubrics follow the typesafe-evaluate conventions and are measured in
 * eval/ against labelled turns; change them there first.
 *
 * Gates only run on turns that came from the person, never on heartbeats, scheduled jobs or
 * messages from other sessions. Without a decision model they report "unavailable" and Work falls
 * back to a reminder in the agent's next brief.
 */
export const RUBRIC_VERSION = 'falcon-work-gates-2026-10-07';

/** Gate left_waiting: after this turn, is the agent waiting on the person? */
export const LEFT_WAITING = {
	type: 'choice',
	instructions: {
		question:
			'After this turn, is the writer of reply left waiting on the person who sent request? Judge what reply asks of that person, in the context of request.',
		focus:
			'Only what the person must supply for the work to continue. Anything already listed in raised_in_work is not waiting.',
		ignore: [
			'steps of a plan, checklist or procedure that describe work, even when written as imperatives',
			'questions quoted from someone else',
			'rhetorical questions the reply answers itself',
			'questions inside code'
		]
	},
	criteria: {
		needs_answer: {
			description: 'reply needs information only the person has',
			includes: [
				'a question to the person about facts, preferences or context',
				'a request to send, paste or share something',
				'a list of items the person is asked to provide'
			],
			excludes: [
				'a choice between options or a go-ahead',
				'an optional offer of more help',
				'a follow-up question the work does not depend on'
			]
		},
		needs_decision: {
			description:
				'reply needs the person to choose, approve or reject before the writer continues',
			includes: [
				'options to choose between',
				'asking for approval or a go-ahead',
				'asking whether a proposal is acceptable',
				'"your call"'
			],
			excludes: ['an optional offer of extra work the person did not ask for']
		},
		needs_action: {
			description: 'reply needs the person to do something themselves',
			includes: [
				'run a command',
				'sign in, reconnect or approve something in another system',
				'open, reload or test something and report back'
			],
			excludes: ['advice about something the person may do for their own reasons']
		},
		offer_only: {
			description:
				'reply only offers optional further help; nothing is blocked if the person ignores it',
			includes: [
				'"If you want, I can also…"',
				'"Want me to also…?" about extra work',
				'a next step the writer will take unless the person says otherwise',
				'"Let me know if you have questions"'
			]
		},
		nothing: {
			description: 'nothing is waiting on the person',
			includes: [
				'a report of finished work',
				"an answer to the person's question",
				"small talk, or a follow-up question about the person's reasons or curiosity that the work does not depend on",
				'a recommendation with nothing asked',
				'everything needed was already raised in Work'
			]
		}
	}
} as const;
export type LeftWaiting = keyof typeof LEFT_WAITING.criteria;
/** Below this, a "needs" outcome is treated as nothing (measured: eval/gate_score.mjs). */
export const LEFT_WAITING_THRESHOLD = 0.5;

/** Gate answers_open_item, for one open Question. */
export const answersQuestion = (id: string) => ({
	type: 'boolean' as const,
	instructions: {
		question: `Does message answer open_items.${id}?`,
		focus:
			"Read message as the person's reply to previous_reply. A message can answer several items at once, in any order or by their number n."
	},
	criteria: {
		true: {
			includes: [
				`gives the information open_items.${id} asks for, even briefly`,
				`a short reply such as yes, fine, ok, go, done or correct, right after previous_reply asked open_items.${id}`,
				`an answer given by the number n of open_items.${id}`,
				`rejects, defers or redirects what open_items.${id} proposes`
			]
		},
		false: {
			includes: [
				'is about something else',
				'asks a question back or asks for clarification instead',
				'only acknowledges without answering',
				'answers a different open item'
			]
		}
	}
});

/** Gate answers_open_item, for one open Decision. */
export const answersDecision = (id: string, options: Record<string, string>) => ({
	type: 'choice' as const,
	instructions: {
		question: `Which option of open_items.${id} does message choose?`,
		focus: `Only open_items.${id}. "Your recommendation", "what you suggested" or "go" choose open_items.${id}.recommendation only when message is about open_items.${id}; if message names a different item, open_items.${id} is not decided.`
	},
	criteria: { ...options, not_decided: `message does not choose an option of open_items.${id}` }
});
/** Recording a wrong answer is worse than missing one (measured: eval/gate2_score.mjs). */
export const ANSWERS_THRESHOLD = 0.7;

/** Gate asked_for: is this piece of the reply part of what it asks the person for? */
export const askedFor = (id: string) => ({
	type: 'boolean' as const,
	instructions: {
		question: `Is pieces.${id} part of what reply asks the person who sent request to give, decide or do?`,
		focus: `Read pieces.${id} within reply. A list item counts when the line introducing the list asks for it.`
	},
	criteria: {
		true: {
			includes: [
				'a question to the person',
				'a request to send, share, confirm, approve or choose something',
				'an item of a list the person is asked to provide',
				'an instruction for the person to do something and report back, which the writer needs before continuing'
			]
		},
		false: {
			includes: [
				'a step of a plan or procedure describing work',
				'a report, explanation or recommendation',
				'a question quoted from someone else or answered by reply itself',
				'an optional offer of more help',
				'small talk or a follow-up question the work does not depend on',
				'advice or steps the person may follow on their own'
			]
		}
	}
});
/** Measured: eval/extract_score.mjs (F1 0.84 against 0.73 for the text extractor). */
export const ASKED_FOR_THRESHOLD = 0.8;

type Decisions = {
	evaluate(
		batch: { state: unknown; questions: Record<string, unknown> },
		options: {
			agentId?: string;
			purpose: string;
			rubricVersion: string;
			timeoutMs: number;
			signal: AbortSignal;
		}
	): Promise<
		| { status: 'ok'; result: { answers: Record<string, any> } }
		| { status: 'unavailable'; reason: unknown }
	>;
};

/** Ask the decision model; null when the Office has none or it fails (never throws). */
export async function decide(
	decisions: Decisions | undefined,
	batch: { state: unknown; questions: Record<string, unknown> },
	purpose: string,
	agentId?: string,
	log?: (line: string) => void
): Promise<Record<string, any> | null> {
	if (!decisions?.evaluate) {
		log?.(`gate ${purpose}: no decision runtime`);
		return null;
	}
	try {
		const out = await decisions.evaluate(batch as never, {
			...(agentId ? { agentId } : {}),
			purpose: `falcon-work.${purpose}`,
			rubricVersion: RUBRIC_VERSION,
			timeoutMs: 20000,
			signal: AbortSignal.timeout(25000)
		});
		if (out.status !== 'ok')
			log?.(`gate ${purpose}: decision model unavailable (${String(out.reason)})`);
		return out.status === 'ok' ? out.result.answers : null;
	} catch (error) {
		log?.(`gate ${purpose}: ${(error as Error).message}`);
		return null;
	}
}

/** Did a person start this turn? Heartbeats, jobs and other sessions are not the person. */
export function fromPerson(
	ctx: { trigger?: string; inputProvenance?: { kind?: string } },
	message: string | undefined
): boolean {
	if (ctx.trigger && ctx.trigger !== 'user') return false;
	if (ctx.inputProvenance?.kind && ctx.inputProvenance.kind !== 'external_user') return false;
	if (!message?.trim()) return false;
	return !/^\s*\[(OpenClaw heartbeat|Subagent Context|Inter-session message|cron:|OpenClaw cron)/i.test(
		message
	);
}

const ASKING =
	/[?？]\s*$|\b(send me|tell me|let me know|reply with|could you|can you|would you|please (share|confirm|send|provide|choose|pick|tell)|i need (you|from you)|your call|say (go|the word)|approve)\b/i;

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

/** The part of a reply that asks the person for something, as one Question prompt. */
export function askingPart(reply: string): string {
	const picked: string[] = [];
	// A sentence that asks and ends with ":" introduces a list; every item of that list is part of it.
	let inAskList = false;
	for (const seg of segments(reply)) {
		if (seg.item && inAskList) {
			picked.push(seg.text);
			continue;
		}
		inAskList = ASKING.test(seg.text) && /:\s*$/.test(seg.text);
		if (ASKING.test(seg.text)) picked.push(seg.text);
	}
	const all = segments(reply).map((x) => x.text);
	const body = (picked.length ? picked : all.slice(-2)).join('\n');
	return body.length > 1900 ? body.slice(0, 1899) + '…' : body;
}
