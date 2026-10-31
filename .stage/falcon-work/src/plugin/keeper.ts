import type { TurnOutcome, Work } from '../store/work.js';
import { decide, RUBRIC_VERSION } from './gates.js';

/**
 * The record keeper (spec §10): after a turn, Work files what it left outside the chat under the
 * right Task, opens a Task for new work and completes one whose done-when is met. The decision
 * model places the turn; the Office's utility model writes the words. Neither is required: without
 * them outcomes still go under the session's Task, or wait as unfiled work.
 */

export const PLACE_THRESHOLD = 0.6;
export const DONE_THRESHOLD = 0.8;
/** New work goes to its Area on a weaker signal than into a Project: an Area is easy to move from. */
export const AREA_THRESHOLD = 0.3;

/** Where new work goes: a Project only when clearly so, else the likeliest Area, else nowhere. */
export function placeFor<P extends { key: string; kind: 'project' | 'area' }>(
	places: P[],
	p: Record<string, number>
): P | null {
	const ranked = places.map((x) => ({ x, p: p[x.key] ?? 0 })).sort((a, b) => b.p - a.p);
	const top = ranked[0];
	if (top && top.x.kind === 'project' && top.p >= PLACE_THRESHOLD) return top.x;
	const area = ranked.find((r) => r.x.kind === 'area');
	return area && area.p >= AREA_THRESHOLD ? area.x : null;
}

type Decisions = Parameters<typeof decide>[0];
export type Writer = (prompt: string) => Promise<string | null>;

export type Turn = {
	agentId: string;
	session: string | null;
	run: string;
	/** What the turn was asked: the person's message, or the task a subagent was given. */
	request: string | null;
	reply: string;
	outcomes: TurnOutcome[];
	/** A person started the turn. */
	person: boolean;
	/** The agent recorded or corrected Work itself this turn: its record wins. */
	agentRecorded: boolean;
};

type Candidate = { key: string; id: string; title: string; done_when: string; place: string };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Same-kind outcomes collapse into one chip each (files by folder), so a timeline stays short. */
export function condense(outcomes: TurnOutcome[]): TurnOutcome[] {
	const out: TurnOutcome[] = [];
	const files = new Map<string, Set<string>>();
	const seen = new Set<string>();
	for (const o of outcomes) {
		if (o.kind === 'file') {
			const path = o.ref ?? o.label;
			const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
			(files.get(dir) ?? files.set(dir, new Set()).get(dir)!).add(path);
			continue;
		}
		const key = `${o.kind}:${o.ref ?? o.label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(o);
	}
	for (const [dir, paths] of files)
		out.push(
			paths.size === 1
				? { kind: 'file', label: [...paths][0], ref: [...paths][0] }
				: { kind: 'file', label: `${paths.size} files in ${dir}`, ref: dir }
		);
	return out;
}

function definition(w: Work, id: string) {
	const t = w.reads.get(id) as {
		definition?: { title?: string; description?: string; done_when?: string };
		project_id?: string | null;
		area_id?: string | null;
	} | null;
	return {
		title: t?.definition?.title ?? '',
		description: t?.definition?.description ?? '',
		done_when: t?.definition?.done_when ?? ''
	};
}

/** Is a Task's done-when met by what this turn shows? */
export const DONE_QUESTION = (field: string) => ({
	type: 'boolean',
	instructions: {
		question: `After this turn, is ${field} met?`,
		focus:
			'Judge from outcomes and reply_end. You cannot open files or links: when reply_end says what was produced and outcomes show it was written, treat that as shown.',
		ignore: ['work that is only planned, promised or proposed']
	},
	criteria: {
		true: {
			description: `everything ${field} asks for is reported done`,
			includes: ['the reply says the file, change or fix was made, and outcomes show it']
		},
		false: {
			description: `some part of ${field} is not reported done`,
			includes: ['a step still pending', 'a test or check failing', 'only a plan or a promise']
		}
	}
});

/** The decision batch for one turn: where it belongs, whether that finishes it, and where new work would go. */
export function placementBattery(input: {
	turn: Turn;
	current: (Candidate & { description: string }) | null;
	others: Candidate[];
	places: { key: string; title: string; kind: 'project' | 'area' }[];
}) {
	const { turn, current, others, places } = input;
	const state = {
		request: turn.request ? clip(turn.request, 1500) : null,
		reply_end: clip(turn.reply.slice(-1500), 1500),
		outcomes: turn.outcomes.map((o) => `${o.kind}: ${o.label}`),
		session_task: current
			? {
					title: current.title,
					description: clip(current.description, 600),
					done_when: current.done_when
				}
			: null,
		other_open_tasks: others.map((t) => ({
			key: t.key,
			title: t.title,
			done_when: clip(t.done_when, 300),
			in: t.place
		})),
		places: places.map((p) => ({ key: p.key, kind: p.kind, title: p.title }))
	};
	const criteria: Record<string, unknown> = {};
	if (current)
		criteria.current = {
			description: 'the outcomes move session_task toward its done_when',
			includes: ['the next step of session_task', 'fixing or testing what session_task produced'],
			excludes: [
				'a separate deliverable started while working on session_task, even in the same Project'
			]
		};
	for (const t of others)
		criteria[t.key] = {
			description: `the outcomes are work on the open Task "${t.title}"`,
			excludes: ['work that only resembles it']
		};
	criteria.new_work = {
		description: 'a distinct piece of work with its own deliverable that no listed Task covers',
		includes: [
			'a second fix, feature or change done in the same conversation',
			'work the request asked for that has no Task yet'
		],
		excludes: ['a step that belongs to a listed Task']
	};
	criteria.not_work = {
		description: 'housekeeping with no deliverable',
		includes: ['scratch or temporary files', 'cleaning up after a test', 'saving notes for itself']
	};
	const questions: Record<string, unknown> = {
		place: {
			type: 'choice',
			instructions: {
				question: 'Which piece of work do the outcomes of this turn belong to?',
				focus: 'Judge outcomes in the light of request and reply_end. One Task is one deliverable.'
			},
			criteria
		},
		where: {
			type: 'choice',
			instructions: {
				question: 'If this is new work, which Project or Area does it belong in?',
				focus:
					'A Project when the work moves that Project toward its outcome; otherwise the Area of responsibility it falls under.'
			},
			criteria: Object.fromEntries([
				...places.map((p) => [p.key, { description: `${p.kind} "${p.title}"` }]),
				['none', { description: 'none of these fits' }]
			])
		}
	};
	if (current) questions.done = DONE_QUESTION('session_task.done_when');
	return { state, questions };
}

/** What the utility model is asked to write, as one JSON object. */
export function writerPrompt(input: {
	turn: Turn;
	task: { title: string; done_when: string } | null;
	needTask: boolean;
	needResult: boolean;
}): string {
	const { turn, task } = input;
	const want = [
		'"summary": one plain sentence (at most 200 characters) saying what this turn changed and, if it matters, what is still left. Name things the person would recognise; never mention tools, commands or files unless they are the point.',
		...(input.needTask
			? [
					'"task": {"title": what the work achieves, at most 80 characters; "description": two or three sentences on what it involves; "done_when": how anyone can tell it is done, observable}'
				]
			: []),
		...(input.needResult ? ['"result": two or three sentences on what the Task produced'] : [])
	];
	return [
		"You keep the record of an AI agent's work for the person it works for. Reply with one JSON object and nothing else, with these fields:",
		...want.map((w) => `- ${w}`),
		'',
		`Asked: ${turn.request ? clip(turn.request, 1500) : '(no request: the agent continued on its own)'}`,
		...(task ? [`Task: ${task.title}`, `Done when: ${task.done_when}`] : []),
		`What it left outside the chat:\n${turn.outcomes.map((o) => `- ${o.kind}: ${o.label}${o.ref && o.ref !== o.label ? ` (${o.ref})` : ''}`).join('\n')}`,
		`End of its reply:\n${clip(turn.reply.slice(-2000), 2000)}`
	].join('\n');
}

function parseJson(text: string | null): Record<string, any> | null {
	if (!text) return null;
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		return JSON.parse(m[0]);
	} catch {
		return null;
	}
}

export async function keepRecord(
	w: Work,
	turn: Turn,
	deps: {
		decisions?: Decisions;
		write?: Writer;
		log?: (line: string) => void;
		logDecisions?: (entry: Record<string, unknown>) => void;
	}
): Promise<{ task: string | null; acted: string[] }> {
	const agent = `agent:${turn.agentId}`;
	const actor = { kind: 'agent' as const, id: agent };
	const outcomes = condense(turn.outcomes);
	const session = turn.session;
	const currentId = w.sessionTask(session);
	const acted: string[] = [];
	const entry = (task: string | null, summary: string | null) => {
		w.recordTurn({
			agent,
			session,
			run: turn.run,
			task,
			outcomes,
			summary,
			by: turn.agentRecorded ? 'agent' : 'work'
		});
		if (task && session) w.setSessionTask(session, task);
	};
	const write = async (prompt: string) => {
		try {
			return parseJson((await deps.write?.(prompt)) ?? null);
		} catch (error) {
			deps.log?.(`record keeper: utility model failed (${(error as Error).message})`);
			return null;
		}
	};

	// A turn that changed nothing outside the chat is only counted, on the Task it discussed.
	if (!outcomes.length) {
		if (turn.person && currentId) entry(currentId, null);
		return { task: currentId, acted };
	}
	// The agent recorded this turn itself: file under its Task, with a written summary only.
	if (turn.agentRecorded) {
		const t = currentId ? definition(w, currentId) : null;
		const text = await write(
			writerPrompt({ turn: { ...turn, outcomes }, task: t, needTask: false, needResult: false })
		);
		entry(currentId, text?.summary ? String(text.summary) : null);
		return { task: currentId, acted };
	}

	const current = currentId
		? { key: 'current', id: currentId, place: '', ...definition(w, currentId) }
		: null;
	const brief = w.reads.brief(agent, null, w.now());
	const others: Candidate[] = [...brief.in_progress, ...brief.waiting]
		.filter((t: { id: string }) => t.id !== currentId)
		.slice(0, 8)
		.map((t: { id: string; title: string }, n: number) => ({
			key: `t${n + 1}`,
			id: t.id,
			title: t.title,
			place: '',
			done_when: definition(w, t.id).done_when
		}));
	const places: { key: string; id: string; title: string; kind: 'project' | 'area' }[] = [];
	for (const a of brief.structure as {
		id: string;
		title: string;
		projects: { id: string; title: string }[];
	}[]) {
		places.push({ key: `a${places.length + 1}`, id: a.id, title: a.title, kind: 'area' });
		for (const p of a.projects)
			places.push({ key: `p${places.length + 1}`, id: p.id, title: p.title, kind: 'project' });
	}
	const batch = placementBattery({ turn: { ...turn, outcomes }, current, others, places });
	const answers = await decide(deps.decisions, batch, 'record', turn.agentId, deps.log);

	let task: string | null = currentId;
	let choice = 'unplaced';
	let p = 0;
	if (answers?.place?.type === 'choice') {
		choice = String(answers.place.choice);
		p = answers.place.probabilities?.[choice] ?? 0;
		if (p < PLACE_THRESHOLD) choice = 'unsure';
	}
	if (choice === 'not_work') {
		deps.logDecisions?.({
			at: w.now(),
			event: 'record',
			rubric: RUBRIC_VERSION,
			session,
			run: turn.run,
			outcomes,
			answers,
			acted: ['not work']
		});
		return { task: null, acted: ['not work'] };
	}
	const other = others.find((t) => t.key === choice);
	if (other) task = other.id;
	const isNew = choice === 'new_work';
	let doneP: number | null = answers?.done?.probabilityTrue ?? null;
	let done =
		!isNew &&
		task === currentId &&
		current &&
		(answers?.done?.probabilityTrue ?? 0) >= DONE_THRESHOLD;

	const shown = isNew ? null : task ? definition(w, task) : null;
	const text = await write(
		writerPrompt({
			turn: { ...turn, outcomes },
			task: shown,
			needTask: isNew,
			needResult: !!done || isNew
		})
	);

	if (isNew) {
		const draft = text?.task;
		const where = placeFor(places, answers?.where?.probabilities ?? {});
		if (draft?.title && draft?.done_when && where) {
			const created = w.do(
				{
					command: 'create_task',
					idempotency_key: `record:${turn.run}`,
					input: {
						title: clip(String(draft.title), 240),
						description: clip(String(draft.description ?? draft.title), 12000),
						done_when: clip(String(draft.done_when), 12000),
						...(where.kind === 'project' ? { project: where.id } : { area: where.id })
					}
				},
				actor
			) as { outcome: string; id?: string };
			if (created.id) {
				w.markRecordedByWork(created.id);
				w.do(
					{
						command: 'start',
						id: created.id,
						idempotency_key: `record-start:${turn.run}`,
						input: { claim: true }
					},
					actor
				);
				task = created.id;
				acted.push(`created ${created.id}`);
				// Work done in the turn that opened the Task may already finish it.
				const check = await decide(
					deps.decisions,
					{
						state: {
							done_when: String(draft.done_when),
							outcomes: outcomes.map((o) => `${o.kind}: ${o.label}`),
							reply_end: clip(turn.reply.slice(-1500), 1500)
						},
						questions: { done: DONE_QUESTION('done_when') }
					},
					'record-done',
					turn.agentId,
					deps.log
				);
				doneP = check?.done?.probabilityTrue ?? null;
				done = (doneP ?? 0) >= DONE_THRESHOLD;
			}
		} else task = null; // new work Work could not write up waits as unfiled
	}
	entry(task, text?.summary ? clip(String(text.summary), 2000) : null);
	if (done && task && text?.result) {
		const r = w.do(
			{
				command: 'complete',
				id: task,
				idempotency_key: `record-complete:${turn.run}`,
				input: {
					content: clip(String(text.result), 12000),
					sources: outcomes
						.slice(0, 50)
						.map((o) => ({ ref: o.ref ?? o.label, kind: o.kind, label: o.label }))
				}
			},
			actor
		);
		if (r.outcome !== 'rejected') acted.push(`completed ${task}`);
	}
	deps.log?.(
		`record keeper: ${choice}${p ? ` ${p.toFixed(2)}` : ''} → ${task ?? 'unfiled'}${doneP !== null ? `, done ${doneP.toFixed(2)}` : ''}${acted.length ? ` (${acted.join(', ')})` : ''}`
	);
	deps.logDecisions?.({
		at: w.now(),
		event: 'record',
		rubric: RUBRIC_VERSION,
		session,
		run: turn.run,
		outcomes,
		answers,
		done: doneP,
		task,
		acted
	});
	return { task, acted };
}
