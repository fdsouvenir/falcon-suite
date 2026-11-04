/**
 * The clerk's questions for the decision model (spec §3.2). All wording, criteria and thresholds
 * live here, versioned by RUBRIC_VERSION, and are measured in eval/ against labelled real turns.
 * Each question asks for one judgment a person could make at a glance; code combines the answers
 * (see decide.ts). Follows the TypeSafe integration guidance (typesafe-ai/skills).
 */
export const RUBRIC_VERSION = 'falcon-work-clerk-2026-11-04c';

/** At or above: yes. At or below NO: no. Between: unsettled (spec §3.3). */
export const YES = 0.7;
export const NO = 0.3;

type Noul = {
	type: 'boolean';
	instructions: string;
	criteria: { true: string; false: string };
};
type Choice = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Question = Noul | Choice;
export type Batch = { state: Record<string, unknown>; questions: Record<string, Question> };

const noul = (instructions: string, yes: string, no: string): Noul => ({
	type: 'boolean',
	instructions,
	criteria: { true: yes, false: no }
});

/** An open Job, Project or Task as the decision model sees it: names, never ids. */
export type Candidate = {
	title: string;
	kind: 'job' | 'project' | 'task';
	status: string;
	done_when: string;
};

export type TurnInput = {
	/** The exchange before this one in the same session, for context. */
	previous?: { request: string | null; reply: string } | null;
	/** The person's message, when a person started the turn. */
	request: string | null;
	reply: string;
	/** What the turn left outside the chat, e.g. "commit: fix importer". */
	outcomes: string[];
	/** The reply split into sentences and list items. */
	pieces: string[];
	/** Open items linked to this session (at most 8). */
	candidates: Candidate[];
	/** Open Questions and Decisions for the person (prompts only). */
	open: string[];
};

export const TURN = {
	work_asked: noul(
		'Does `request` ask the agent to do a piece of work?',
		'the person asks the agent to build, fix, set up, change, investigate, check, find or write something',
		'the person makes small talk, says thanks, gives feedback without asking for anything, or asks a quick question that `reply` simply answers'
	),
	work_reported: noul(
		'Does `reply` report that a piece of work was finished or delivered?',
		'the agent says something was made, changed, fixed, installed, published, written or sent',
		'the agent only explains, answers a question, lays out a plan, or reports progress on work that is not finished'
	),
	work_planned: noul(
		'Does `reply` lay out a plan of several steps of work the agent will carry out?',
		'the agent gives phases or numbered steps of its own work still to come',
		'the agent names one or two next steps, lists options for the person to choose from, says what it will do once the person answers, or explains a method for the person to follow'
	),
	needs_person: noul(
		'Does `reply` ask the person for something the work cannot continue without?',
		'the agent needs an answer, a choice, an approval or an action from the person before it can go on',
		'the agent only offers optional extra help ("want me to also…?"), asks a rhetorical question, or asks nothing'
	),
	waits_outside: noul(
		'Does `reply` say the work cannot continue until something other than the person happens?',
		'the agent is waiting for a third party to reply, a build or deploy to finish, an access grant from someone else, or a date',
		'nothing blocks the work, the agent is still working around a problem itself, or the work only waits on the person'
	),
	new_work: noul(
		'Does `request` ask for a piece of work that is none of the items in `candidates`?',
		'a different deliverable from every listed item, even one in the same area or from the same conversation',
		'a step, fix, check or report on a listed item, or no work asked'
	),
	any_item: noul(
		'Is this exchange part of the work on any of the items in `candidates`?',
		'the exchange continues, finishes, checks, reports on or plans next steps of one of the listed pieces of work',
		'the exchange is about a different piece of work, or about nothing in particular'
	)
} as const;

export const about = (c: string) =>
	noul(
		`Is this exchange part of the work on \`candidates.${c}\`?`,
		`the exchange continues, finishes, checks, reports on or plans next steps of \`candidates.${c}\``,
		`the exchange is about a different piece of work, even a related one`
	);

export const done = (c: string) =>
	noul(
		`Does this exchange show that \`candidates.${c}.done_when\` is met?`,
		'the reply reports, with outcomes or specifics, that everything the done-when asks for has happened',
		'part of the done-when is still pending, failing, only planned or only promised'
	);

export const stands = (p: string) =>
	noul(
		`Does \`pieces.${p}\` say where the work now stands?`,
		'it states what is now done, what is in progress, or what is left to do',
		'it explains, offers, asks, gives background or instructions'
	);

export const asks = (p: string) =>
	noul(
		`Is \`pieces.${p}\` part of what \`reply\` asks the person to give, decide or do?`,
		'a question to the person, a request to send, confirm, approve or choose something, or an item of a list the person is asked to provide',
		'a step of a plan, a report, an explanation, an optional offer, or advice the person may follow on their own'
	);

export const repeats = (q: string) =>
	noul(
		`Does \`reply\` ask the person for the same thing as \`open.${q}\`?`,
		'the same request, in any wording',
		'a related but different request, or nothing'
	);

const keyed = <T>(prefix: string, list: T[]) =>
	Object.fromEntries(list.map((v, n) => [`${prefix}${n + 1}`, v]));

/** One bundled request for the end of a turn (spec §3.2). */
export function turnBatch(input: TurnInput): Batch {
	const candidates = keyed('c', input.candidates.slice(0, 8));
	const pieces = keyed('p', input.pieces.slice(-40));
	const open = keyed('q', input.open.slice(0, 20));
	const questions: Record<string, Question> = {
		work_asked: TURN.work_asked,
		work_reported: TURN.work_reported,
		work_planned: TURN.work_planned,
		needs_person: TURN.needs_person,
		waits_outside: TURN.waits_outside
	};
	if (Object.keys(candidates).length) {
		questions.any_item = TURN.any_item;
		questions.new_work = TURN.new_work;
	}
	for (const c of Object.keys(candidates)) {
		questions[`about.${c}`] = about(c);
		questions[`done.${c}`] = done(c);
	}
	for (const p of Object.keys(pieces)) {
		questions[`stands.${p}`] = stands(p);
		questions[`asks.${p}`] = asks(p);
	}
	for (const q of Object.keys(open)) questions[`repeats.${q}`] = repeats(q);
	const state: Record<string, unknown> = {
		...(input.previous
			? {
					previous_exchange: {
						request: input.previous.request ? input.previous.request.slice(0, 600) : null,
						reply_end: input.previous.reply.slice(-1200)
					}
				}
			: {}),
		request: input.request ? input.request.slice(0, 2000) : null,
		reply: input.reply.slice(-6000),
		outcomes: input.outcomes.slice(0, 30),
		pieces
	};
	if (Object.keys(candidates).length) state.candidates = candidates;
	if (Object.keys(open).length) state.open = open;
	return { state, questions };
}

/** The person's message against what is open for them (measured in Work 5: precision 1.00). */
export const answers = (q: string) =>
	noul(
		`Does \`message\` answer \`open.${q}\`?`,
		`it gives what \`open.${q}\` asks for, even briefly; a short yes, ok or go right after \`previous_reply\` asked it; or it rejects, defers or redirects it`,
		'it is about something else, asks a question back, only acknowledges, or answers a different open item'
	);

export const decides = (d: string) =>
	noul(
		`Does \`message\` choose one of the options of \`open.${d}\`?`,
		`it picks an option of \`open.${d}\`, by name, by number, or by accepting the recommendation`,
		`it does not choose, or it is about a different open item`
	);

export const option = (d: string, options: Record<string, string>): Choice => ({
	type: 'choice',
	instructions: `Which option of \`open.${d}\` does \`message\` choose?`,
	criteria: options
});

/** Checks on what the writer proposes (spec §3.3). */
export const same = (n: string, o: string) =>
	noul(
		`Is \`proposed.${n}\` the same piece of work as \`open.${o}\`?`,
		'the same deliverable, even worded differently',
		'a different deliverable, even a related one in the same area'
	);

/** Nightly tidy over an open item's latest timeline entries. */
export const NIGHTLY = {
	finished: noul(
		'Do `entries` show that `item` was finished?',
		'the entries report its outcome delivered',
		'the entries report progress, waiting or nothing conclusive'
	),
	dropped: noul(
		'Do `entries` show that `item` was dropped or is no longer wanted?',
		'the person or agent abandoned, cancelled or replaced it',
		'the entries show it still wanted, or say nothing about it'
	)
} as const;

/** A yes/no answer read with the thresholds: true, false, or null when unsettled. */
export function read(p: number | undefined): boolean | null {
	if (p === undefined || Number.isNaN(p)) return null;
	if (p >= YES) return true;
	if (p <= NO) return false;
	return null;
}
