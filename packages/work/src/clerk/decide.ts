import { YES, NO } from './questions.js';

/**
 * Decisions in code (spec §3.3): Jev's answers for one turn become actions through explicit
 * rules. Every combination has an outcome; anything unsettled goes to the writer.
 */

export type Slot = { slot: string; id: string; kind: 'task' | 'project' | 'job' };

export type TurnFacts = {
	answers: Record<string, number>;
	candidates: Slot[];
	/** The pieces as sent (p1…pN). */
	pieces: string[];
	/** Open Questions for the person as sent (q1…qN). */
	open: { slot: string; id: string }[];
	outcomes: number;
	/** The Job whose automation started this session, if any. */
	automationJob: string | null;
};

export type TurnActions = {
	/** Items this turn's work is filed under. */
	file: Slot[];
	/** One sentence on where things stand, from the reply. */
	statusLine: string | null;
	/** Tasks whose done-when this turn shows met, with the reporting pieces as result. */
	complete: { slot: Slot; result: string | null }[];
	/** A Question for the person, in the reply's own words. */
	raise: string | null;
	/** An open Question this reply repeats: link the session to it instead of raising. */
	repeats: string | null;
	/** The work now waits on something outside (reason). */
	waitsOutside: string | null;
	/** Why the writer should look at this session; empty when code settled everything. */
	writer: string[];
	/** Nothing to record. */
	chat: boolean;
};

const yes = (p: number | undefined) => p !== undefined && p >= YES;
const no = (p: number | undefined) => p === undefined || p <= NO;
const unsettled = (p: number | undefined) => p !== undefined && p > NO && p < YES;

function best(pieces: string[], answers: Record<string, number>, prefix: string): string | null {
	let top: [string, number] | null = null;
	pieces.forEach((text, n) => {
		const p = answers[`${prefix}.p${n + 1}`];
		if (p !== undefined && p >= YES && (!top || p > top[1])) top = [text, p];
	});
	return top ? (top as [string, number])[0] : null;
}

function picked(pieces: string[], answers: Record<string, number>, prefix: string): string[] {
	return pieces.filter((_, n) => yes(answers[`${prefix}.p${n + 1}`]));
}

export function decideTurn(f: TurnFacts): TurnActions {
	const a = f.answers;
	const out: TurnActions = {
		file: [],
		statusLine: null,
		complete: [],
		raise: null,
		repeats: null,
		waitsOutside: null,
		writer: [],
		chat: false
	};
	const asked = yes(a.work_asked);
	const reported = yes(a.work_reported);
	const anyWork = asked || reported || f.outcomes > 0;

	// Pure conversation: nothing to file, unless the session already has an item it is about.
	if (no(a.work_asked) && no(a.work_reported) && f.outcomes === 0) out.chat = true;

	// Which items this turn belongs to.
	const about = f.candidates.filter((c) => yes(a[`about.${c.slot}`]));
	const unsure = f.candidates.some((c) => unsettled(a[`about.${c.slot}`]));
	if (about.length && !no(a.any_item)) out.file = about;
	else if (f.automationJob) {
		const job = f.candidates.find((c) => c.id === f.automationJob);
		if (job) out.file = [job];
	}
	const noneFits = f.candidates.every((c) => no(a[`about.${c.slot}`]));
	if (anyWork && (yes(a.new_work) || (noneFits && !out.file.length))) out.writer.push('new work');
	if (unsure && !out.chat) out.writer.push('unsure which item');
	if (!out.chat && (unsettled(a.work_asked) || unsettled(a.work_reported)))
		out.writer.push('unsettled');
	if (yes(a.work_planned)) out.writer.push('a plan');

	out.statusLine = out.file.length ? best(f.pieces, a, 'stands') : null;

	// Completion: a filed Task whose done-when is met, when the reply reports work finished.
	for (const c of out.file)
		if (c.kind === 'task' && yes(a[`done.${c.slot}`]) && reported) {
			const result = picked(f.pieces, a, 'stands').join(' ');
			out.complete.push({ slot: c, result: result || null });
			if (!result) out.writer.push('result');
		} else if (c.kind !== 'task' && yes(a[`done.${c.slot}`])) out.writer.push('outcome met');

	// Needs you: only when the work is an item (filed or new) and it is not already open.
	if (yes(a.needs_person) && (out.file.length || out.writer.includes('new work'))) {
		const repeated = f.open.find((q) => yes(a[`repeats.${q.slot}`]));
		if (repeated) out.repeats = repeated.id;
		else {
			const text = picked(f.pieces, a, 'asks').join('\n');
			if (text) out.raise = text.length > 1900 ? text.slice(0, 1899) + '…' : text;
			else out.writer.push('a question for the person');
		}
	} else if (unsettled(a.needs_person) && out.file.length) out.writer.push('maybe a question');

	if (yes(a.waits_outside) && out.file.length)
		out.waitsOutside = out.statusLine ?? 'Waiting on something outside';

	out.writer = [...new Set(out.writer)];
	return out;
}
