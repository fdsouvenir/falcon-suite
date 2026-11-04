import type { Work, TurnOutcome, ItemKind } from '../store/work.js';
import { CLERK, type Actor, type Outcome } from '../store/types.js';
import { segments } from './pieces.js';
import {
	RUBRIC_VERSION,
	turnBatch,
	answers as answersQ,
	decides as decidesQ,
	option as optionQ,
	same as sameQ,
	done as doneQ,
	YES,
	type Batch,
	type Candidate
} from './questions.js';
import { decideTurn, type Slot, type TurnActions } from './decide.js';
import { WRITER_SYSTEM, writerPrompt, parseEdits, type Edit } from './writer.js';

/** A completed turn: what the person (or automation) asked and what the agent answered. */
export type Turn = {
	agentId: string;
	session: string;
	run: string;
	request: string | null;
	reply: string;
	outcomes: TurnOutcome[];
	at?: string;
	/** Seq of the turn's last transcript entry, when known (catch-up). */
	seq?: number;
};

export type Msg = { seq: number; role: 'user' | 'assistant'; text: string; at: string };

export type Decisions = {
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

export type ClerkDeps = {
	work: Work;
	decisions?: () => Decisions | undefined;
	/** One tool-free completion on the agent's own model. */
	complete?: (agentId: string, system: string, message: string) => Promise<string>;
	/** Sessions of an agent with activity, newest first. */
	sessions: (agentId: string) => { sessionKey: string; sessionId?: string; updatedAt: number }[];
	/** A session's visible messages (user and assistant text), in order. */
	read: (agentId: string, sessionKey: string, sessionId?: string) => Promise<Msg[]>;
	agents: () => string[];
	log: (line: string) => void;
	logDecision?: (entry: Record<string, unknown>) => void;
	changed: () => void;
};

const MAX_CONVERSATION_CHARS = 40000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Answers as plain numbers: a Noul's probability, a Choice's top option's probability. */
function flatten(raw: Record<string, any>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw ?? {})) {
		if (typeof v === 'number') out[k] = v;
		else if (v?.type === 'boolean' && typeof v.probabilityTrue === 'number')
			out[k] = v.probabilityTrue;
		else if (typeof v?.noul === 'number') out[k] = v.noul;
	}
	return out;
}

/** The automation id a session belongs to (`agent:<id>:cron:<automation>`), if any. */
export const automationOf = (session: string) => /:cron:([^:]+)/.exec(session)?.[1] ?? null;

/**
 * The clerk (spec §3): judges each turn with the decision model, acts on the answers in code,
 * and calls the writer for what code cannot settle. It only reads conversations and writes the
 * record; it never sends anything.
 */
export class Clerk {
	/** The previous exchange per session, for the judging context. */
	private readonly previous = new Map<string, { request: string | null; reply: string }>();
	/** Outcomes per session since the last writer pass. */
	private readonly outcomes = new Map<string, TurnOutcome[]>();
	private readonly lastReply = new Map<string, string>();

	constructor(private readonly d: ClerkDeps) {}

	private get w() {
		return this.d.work;
	}

	private evaluate = async (batch: Batch, purpose: string, agentId?: string) => {
		const decisions = this.d.decisions?.();
		if (!decisions?.evaluate) return null;
		try {
			const r = await decisions.evaluate(batch as never, {
				...(agentId ? { agentId } : {}),
				purpose: `falcon-work.${purpose}`,
				rubricVersion: RUBRIC_VERSION,
				timeoutMs: 20000,
				signal: AbortSignal.timeout(25000)
			});
			if (r.status !== 'ok') {
				this.d.log(`clerk: decision model unavailable for ${purpose} (${String(r.reason)})`);
				return null;
			}
			return flatten(r.result.answers);
		} catch (error) {
			// A failed call is an error, never a "no" (spec §3.6).
			this.d.log(`clerk: decision model failed for ${purpose}: ${(error as Error).message}`);
			return null;
		}
	};

	private do(
		command: string,
		input: Record<string, unknown>,
		id?: string,
		key?: string,
		actor: Actor = CLERK
	): Outcome {
		const r = this.w.do(
			{ command, ...(id ? { id } : {}), input, ...(key ? { idempotency_key: key } : {}) },
			actor
		);
		if (r.outcome === 'rejected') this.d.log(`clerk: ${command} rejected (${r.code}: ${r.reason})`);
		return r;
	}

	private checkpoint(session: string) {
		return this.w.db
			.prepare('SELECT * FROM clerk_checkpoint WHERE session_key = ?')
			.get(session) as
			| {
					session_key: string;
					agent_id: string;
					last_seq: number;
					marked: string | null;
					attempts: number;
					updated_at: string;
			  }
			| undefined;
	}

	/** Mark a session for the writer with reasons. */
	mark(agentId: string, session: string, reasons: string[]) {
		if (!reasons.length) return;
		const cp = this.checkpoint(session);
		const prior: string[] = cp?.marked ? JSON.parse(cp.marked) : [];
		const marked = JSON.stringify([...new Set([...prior, ...reasons])].slice(0, 20));
		this.w.db
			.prepare(
				`INSERT INTO clerk_checkpoint (session_key, agent_id, last_seq, marked, attempts, updated_at) VALUES (?,?,0,?,0,?)
				 ON CONFLICT (session_key) DO UPDATE SET marked = excluded.marked, updated_at = excluded.updated_at`
			)
			.run(session, agentId, marked, this.w.now());
	}

	marked(): { session: string; agentId: string; reasons: string[] }[] {
		return (
			this.w.db
				.prepare(
					'SELECT session_key, agent_id, marked FROM clerk_checkpoint WHERE marked IS NOT NULL'
				)
				.all() as {
				session_key: string;
				agent_id: string;
				marked: string;
			}[]
		).map((r) => ({ session: r.session_key, agentId: r.agent_id, reasons: JSON.parse(r.marked) }));
	}

	private candidates(session: string): (Slot & { c: Candidate })[] {
		const automation = automationOf(session);
		const job = automation ? this.w.jobForAutomation(automation) : null;
		const items = this.w.sessionItems(session, 8);
		if (job && !items.some((i) => i.id === job)) items.unshift({ id: job, kind: 'job' });
		return items.slice(0, 8).map((it, n) => {
			const v = this.w.views;
			const detail: any =
				it.kind === 'task'
					? v.task(it.id)
					: it.kind === 'project'
						? v.project(it.id)
						: v.job(it.id);
			return {
				slot: `c${n + 1}`,
				id: it.id,
				kind: it.kind,
				c: {
					title: detail?.title ?? '',
					kind: it.kind,
					status: detail?.status_line ?? detail?.status ?? 'open',
					done_when:
						it.kind === 'task'
							? (detail?.done_when ?? '')
							: it.kind === 'project'
								? (detail?.outcome ?? '')
								: (detail?.instructions ?? '')
				}
			};
		});
	}

	/** Remember a turn's outcomes for the writer, from the after_tool_call capture. */
	noteOutcomes(session: string, outcomes: TurnOutcome[]) {
		if (!outcomes.length) return;
		this.outcomes.set(session, [...(this.outcomes.get(session) ?? []), ...outcomes].slice(-100));
	}

	/** End of a turn (spec §3.1): judge it, act on the answers, and mark the session if needed. */
	async judgeTurn(turn: Turn): Promise<TurnActions | null> {
		this.noteOutcomes(turn.session, turn.outcomes);
		this.lastReply.set(turn.session, turn.reply);
		const previous = this.previous.get(turn.session) ?? null;
		this.previous.set(turn.session, { request: turn.request, reply: turn.reply });
		if (!turn.reply.trim()) return null;
		const cands = this.candidates(turn.session);
		const pieces = segments(turn.reply)
			.slice(-40)
			.map((p) => p.text);
		const open = this.w.views
			.needsYou()
			.filter((n) => n.kind === 'question')
			.slice(0, 20)
			.map((n, i) => ({ slot: `q${i + 1}`, id: n.id, prompt: n.prompt }));
		const batch = turnBatch({
			previous,
			request: turn.request,
			reply: turn.reply,
			outcomes: turn.outcomes.map((o) => `${o.kind}: ${o.label}`),
			pieces,
			candidates: cands.map((c) => c.c),
			open: open.map((q) => q.prompt)
		});
		const answers = await this.evaluate(batch, 'turn', turn.agentId);
		if (!answers) {
			this.mark(turn.agentId, turn.session, ['no decision model']);
			return null;
		}
		const automation = automationOf(turn.session);
		const actions = decideTurn({
			answers,
			candidates: cands.map(({ slot, id, kind }) => ({ slot, id, kind })),
			pieces,
			open,
			outcomes: turn.outcomes.length,
			automationJob: automation ? this.w.jobForAutomation(automation) : null
		});
		this.apply(turn, actions);
		this.mark(turn.agentId, turn.session, actions.writer);
		this.d.logDecision?.({
			at: this.w.now(),
			event: 'turn',
			rubric: RUBRIC_VERSION,
			session: turn.session,
			run: turn.run,
			answers: Object.fromEntries(
				Object.entries(answers)
					.filter(([k]) => !/^(stands|asks)\./.test(k))
					.map(([k, v]) => [k, Number(v.toFixed(3))])
			),
			actions: {
				...actions,
				file: actions.file.map((f) => f.id),
				complete: actions.complete.map((c) => c.slot.id)
			}
		});
		return actions;
	}

	private apply(turn: Turn, a: TurnActions) {
		let changed = false;
		const key = (s: string) => `clerk:${turn.run}:${s}`;
		for (const item of a.file) {
			this.w.recordEntry({
				agent: `agent:${turn.agentId}`,
				item: { id: item.id, kind: item.kind },
				session: turn.session,
				run: turn.run,
				outcomes: turn.outcomes,
				summary: a.statusLine,
				by: 'work',
				at: turn.at
			});
			if (a.statusLine)
				this.do(
					'set_status_line',
					{ item: item.id, status_line: clip(a.statusLine, 2000) },
					undefined,
					key(`status:${item.id}`)
				);
			changed = true;
		}
		for (const c of a.complete) {
			if (!c.result) continue;
			const r = this.do(
				'complete',
				{
					content: clip(c.result, 12000),
					sources: [
						{ kind: 'session', ref: turn.session, label: 'Reported in the conversation' },
						...turn.outcomes
							.slice(0, 20)
							.map((o) => ({ kind: o.kind, ref: o.ref ?? o.label, label: o.label }))
					]
				},
				c.slot.id,
				key(`complete:${c.slot.id}`)
			);
			changed ||= r.outcome !== 'rejected';
		}
		const task = a.file.find((f) => f.kind === 'task');
		if (a.repeats) {
			this.w.db
				.prepare('UPDATE question SET session_key = ? WHERE id = ?')
				.run(turn.session, a.repeats);
			changed = true;
		} else if (a.raise) {
			const about = a.file[0];
			const r = this.do(
				'raise_question',
				{
					prompt: a.raise,
					impact: 'The agent asked this in the conversation and the work waits on it.',
					answerable_by: [this.w.owner],
					session: turn.session,
					...(about ? { targets: [{ kind: about.kind, id: about.id }] } : {})
				},
				undefined,
				key('raise')
			);
			if (r.outcome !== 'rejected' && task)
				this.do(
					'wait',
					{
						waiting_for: clip(a.raise, 12000),
						waiting_on: { kind: 'person', ref: this.w.owner },
						resume_when: 'The person answers'
					},
					task.id,
					key(`wait:${task.id}`)
				);
			changed ||= r.outcome !== 'rejected';
		} else if (a.waitsOutside && task) {
			const r = this.do(
				'wait',
				{
					waiting_for: clip(a.waitsOutside, 12000),
					waiting_on: { kind: 'external', ref: 'outside' },
					resume_when: 'What it waits on happens'
				},
				task.id,
				key(`waitout:${task.id}`)
			);
			changed ||= r.outcome !== 'rejected';
		}
		if (changed) this.d.changed();
	}

	/** The person's message: record answers to what is open for them (spec §3.2). */
	async checkAnswers(agentId: string, session: string, message: string, run: string) {
		const open = this.w.views.needsYou().slice(0, 20);
		if (!open.length || !message.trim()) return;
		const keyed = open.map((n, i) => ({
			...n,
			slot: n.kind === 'question' ? `q${i + 1}` : `d${i + 1}`
		}));
		const questions: Batch['questions'] = {};
		for (const n of keyed) {
			if (n.kind === 'question') questions[`answers.${n.slot}`] = answersQ(n.slot);
			else {
				questions[`decides.${n.slot}`] = decidesQ(n.slot);
				questions[`option.${n.slot}`] = optionQ(
					n.slot,
					Object.fromEntries((n.options ?? []).map((o) => [o.id, o.label]))
				);
			}
		}
		const decisions = this.d.decisions?.();
		if (!decisions?.evaluate) return;
		let raw: Record<string, any>;
		try {
			const r = await decisions.evaluate(
				{
					state: {
						previous_reply: (this.lastReply.get(session) ?? '').slice(-2000),
						message,
						open: Object.fromEntries(
							keyed.map((n) => [
								n.slot,
								n.kind === 'question'
									? { prompt: n.prompt }
									: { prompt: n.prompt, options: n.options, recommendation: n.recommendation }
							])
						)
					},
					questions
				},
				{
					agentId,
					purpose: 'falcon-work.message',
					rubricVersion: RUBRIC_VERSION,
					timeoutMs: 20000,
					signal: AbortSignal.timeout(25000)
				}
			);
			if (r.status !== 'ok') return;
			raw = r.result.answers;
		} catch {
			return;
		}
		const a = flatten(raw);
		const person: Actor = { kind: 'human', id: this.w.owner };
		let changed = false;
		for (const n of keyed) {
			if (n.kind === 'question' && (a[`answers.${n.slot}`] ?? 0) >= YES) {
				const r = this.do(
					'answer',
					{
						answer: clip(message, 12000),
						confidence: 'confirmed',
						sources: [{ kind: 'session', ref: session, label: 'Answered in chat' }]
					},
					n.id,
					`clerk-answer:${run}:${n.id}`,
					person
				);
				changed ||= r.outcome !== 'rejected';
			}
			if (n.kind === 'decision' && (a[`decides.${n.slot}`] ?? 0) >= YES) {
				const choice = raw[`option.${n.slot}`];
				const opt = choice?.choice as string | undefined;
				if (opt && (choice?.probabilities?.[opt] ?? 0) >= YES) {
					const r = this.do(
						'decide',
						{ option: opt, rationale: `Decided in chat: ${clip(message, 1900)}` },
						n.id,
						`clerk-decide:${run}:${n.id}`,
						person
					);
					changed ||= r.outcome !== 'rejected';
				}
			}
		}
		if (changed) this.d.changed();
	}

	/** The open record the writer sees: candidates plus everything open, compactly. */
	private recordFor(session: string) {
		const v = this.w.views;
		const linked = new Set(this.w.sessionItems(session, 20).map((i) => i.id));
		const board = v.board();
		const cards = [...board.moving, ...board.waiting];
		const out: unknown[] = [];
		for (const c of cards
			.sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)))
			.slice(0, 25)) {
			if (c.kind === 'project') {
				const p = v.project(c.id)!;
				out.push({
					id: c.id,
					kind: 'project',
					title: p.title,
					outcome: p.outcome,
					status_line: p.status_line,
					in_this_conversation: linked.has(c.id),
					milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, state: m.state })),
					tasks: [...p.milestones.flatMap((m) => m.tasks), ...p.other_tasks].map((t) => ({
						id: t.id,
						title: t.title,
						status: t.status
					}))
				});
			} else if (c.kind === 'job') {
				const j = v.job(c.id)!;
				out.push({
					id: c.id,
					kind: 'job',
					title: j.title,
					instructions: clip(j.instructions, 600),
					status_line: j.status_line,
					in_this_conversation: linked.has(c.id),
					open_tasks: j.open_tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }))
				});
			} else {
				const t = v.task(c.id)!;
				out.push({
					id: c.id,
					kind: 'task',
					title: t.title,
					done_when: t.done_when,
					status: t.status,
					status_line: t.status_line,
					in_this_conversation: linked.has(c.id)
				});
			}
		}
		// Open Tasks inside Projects or Jobs that this session touched, so the writer can update them.
		for (const id of linked) {
			if (out.some((o: any) => o.id === id)) continue;
			const t = v.task(id);
			if (t && ['open', 'ready', 'in_progress', 'waiting'].includes(t.status))
				out.push({
					id,
					kind: 'task',
					title: t.title,
					done_when: t.done_when,
					status: t.status,
					status_line: t.status_line,
					in_this_conversation: true,
					belongs_to: t.belongs_to?.id ?? null
				});
		}
		return out;
	}

	/** A writer pass over a session (spec §3.4). Returns the number of edits applied, or null if skipped. */
	async writerPass(agentId: string, session: string, force = false): Promise<number | null> {
		const cp = this.checkpoint(session);
		const reasons: string[] = cp?.marked ? JSON.parse(cp.marked) : [];
		if (!reasons.length && !force) return null;
		if (!this.d.complete) return null;
		let msgs: Msg[];
		try {
			msgs = await this.d.read(agentId, session);
		} catch (error) {
			this.d.log(`clerk: could not read ${session}: ${(error as Error).message}`);
			return this.failed(session);
		}
		const from = cp?.last_seq ?? 0;
		const delta = msgs.filter((m) => m.seq > from && m.text.trim());
		if (!delta.length) {
			this.done(session, agentId, from);
			return 0;
		}
		// Most recent first, within a budget, then back in order.
		const conversation: { role: string; text: string }[] = [];
		let size = 0;
		for (let i = delta.length - 1; i >= 0 && size < MAX_CONVERSATION_CHARS; i--) {
			const text = clip(delta[i].text, 6000);
			size += text.length;
			conversation.unshift({ role: delta[i].role === 'user' ? 'person' : 'agent', text });
		}
		const automation = automationOf(session);
		const input = {
			reasons: reasons.length ? reasons : ['sweep'],
			record: this.recordFor(session),
			open_questions: this.w.views
				.needsYou()
				.filter((n) => n.kind === 'question')
				.map((n) => ({ id: n.id, prompt: clip(n.prompt, 600) })),
			conversation,
			outcomes: (this.outcomes.get(session) ?? []).map((o) => `${o.kind}: ${o.label}`).slice(-50),
			automation_job: automation ? this.w.jobForAutomation(automation) : null
		};
		let text: string;
		try {
			text = await this.d.complete(agentId, WRITER_SYSTEM, writerPrompt(input));
		} catch (error) {
			this.d.log(`clerk: writer failed for ${session}: ${(error as Error).message}`);
			return this.failed(session);
		}
		const edits = parseEdits(text);
		const applied = await this.applyEdits(agentId, session, edits, delta[delta.length - 1].seq);
		this.outcomes.delete(session);
		this.done(session, agentId, delta[delta.length - 1].seq);
		this.d.logDecision?.({
			at: this.w.now(),
			event: 'writer',
			session,
			reasons: input.reasons,
			edits: edits.length,
			applied
		});
		if (applied) this.d.changed();
		return applied;
	}

	private failed(session: string): null {
		this.w.db
			.prepare(
				'UPDATE clerk_checkpoint SET attempts = attempts + 1, updated_at = ? WHERE session_key = ?'
			)
			.run(this.w.now(), session);
		const cp = this.checkpoint(session);
		if (cp && cp.attempts >= 3) {
			this.d.log(`clerk: ${session} failed 3 times; left for the nightly sweep`);
			this.w.db
				.prepare('UPDATE clerk_checkpoint SET marked = NULL WHERE session_key = ?')
				.run(session);
		}
		return null;
	}

	private done(session: string, agentId: string, seq: number) {
		this.w.db
			.prepare(
				`INSERT INTO clerk_checkpoint (session_key, agent_id, last_seq, marked, attempts, updated_at) VALUES (?,?,?,NULL,0,?)
				 ON CONFLICT (session_key) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq), marked = NULL, attempts = 0, updated_at = excluded.updated_at`
			)
			.run(session, agentId, seq, this.w.now());
	}

	/** Check the writer's proposals with Jev (spec §3.3), then apply them through the store. */
	private async applyEdits(
		agentId: string,
		session: string,
		edits: Edit[],
		seq: number
	): Promise<number> {
		const keys = new Map<string, { id: string; kind: ItemKind }>();
		const resolve = (ref?: string) => (ref ? (keys.get(ref)?.id ?? ref) : undefined);
		const kindOf = (ref?: string) =>
			ref ? (keys.get(ref)?.kind ?? this.w.kindOf(resolve(ref)!)) : null;
		const ik = (s: string) => `clerk-w:${session}:${seq}:${s}`;
		let applied = 0;

		// Duplicates: is a proposed new item the same as an open one?
		const creates = edits.filter(
			(e): e is Extract<Edit, { op: 'create_task' | 'create_project' | 'create_job' }> =>
				e.op.startsWith('create_')
		);
		const open = [...this.w.views.board().moving, ...this.w.views.board().waiting].slice(0, 20);
		const dupOf = new Map<Edit, string>();
		if (creates.length && open.length) {
			const questions: Batch['questions'] = {};
			creates.forEach((_, n) =>
				open.forEach(
					(_, m) => (questions[`same.n${n + 1}.o${m + 1}`] = sameQ(`n${n + 1}`, `o${m + 1}`))
				)
			);
			const a = await this.evaluate(
				{
					state: {
						proposed: Object.fromEntries(
							creates.map((e, n) => [
								`n${n + 1}`,
								{
									kind: e.op.slice(7),
									title: e.title,
									...('done_when' in e ? { done_when: e.done_when } : {}),
									...('outcome' in e ? { outcome: e.outcome } : {})
								}
							])
						),
						open: Object.fromEntries(
							open.map((o, m) => [
								`o${m + 1}`,
								{ kind: o.kind, title: o.title, status: o.status_line }
							])
						)
					},
					questions
				},
				'check',
				agentId
			);
			if (a)
				creates.forEach((e, n) => {
					const hit = open.findIndex((_, m) => (a[`same.n${n + 1}.o${m + 1}`] ?? 0) >= YES);
					if (hit >= 0) dupOf.set(e, open[hit].id);
				});
		}

		for (const e of edits) {
			let r: Outcome | null = null;
			switch (e.op) {
				case 'create_job':
				case 'create_project':
				case 'create_task': {
					const dup = dupOf.get(e);
					if (dup) {
						if (e.key) keys.set(e.key, { id: dup, kind: this.w.kindOf(dup)! });
						this.w.linkSession(dup, this.w.kindOf(dup)!, session);
						continue;
					}
					if (e.op === 'create_job')
						r = this.do(
							'create_job',
							{
								title: clip(e.title, 240),
								instructions: clip(e.instructions, 12000),
								agent: `agent:${agentId}`,
								...(e.status_line ? { status_line: clip(e.status_line, 2000) } : {})
							},
							undefined,
							ik(`job:${e.title}`)
						);
					else if (e.op === 'create_project')
						r = this.do(
							'create_project',
							{
								title: clip(e.title, 240),
								outcome: clip(e.outcome, 12000),
								agent: `agent:${agentId}`,
								...(e.status_line ? { status_line: clip(e.status_line, 2000) } : {}),
								...(e.milestones?.length
									? {
											milestones: e.milestones.slice(0, 20).map((m) => ({
												title: clip(m.title, 240),
												success_condition: clip(m.success_condition, 12000)
											}))
										}
									: {})
							},
							undefined,
							ik(`project:${e.title}`)
						);
					else {
						const project = resolve(e.project);
						const job = resolve(e.job);
						r = this.do(
							'create_task',
							{
								title: clip(e.title, 240),
								description: clip(e.description || e.title, 12000),
								done_when: clip(e.done_when, 12000),
								agent: `agent:${agentId}`,
								...(project && kindOf(e.project) === 'project'
									? { project, ...(e.milestone ? { milestone: e.milestone } : {}) }
									: {}),
								...(job && kindOf(e.job) === 'job' ? { job } : {}),
								...(e.status_line ? { status_line: clip(e.status_line, 2000) } : {})
							},
							undefined,
							ik(`task:${e.title}`)
						);
						if (r.outcome.startsWith('committed') && 'id' in r && r.id)
							this.do('start', {}, r.id, ik(`start:${r.id}`));
					}
					if (r && 'id' in r && r.id && e.key)
						keys.set(e.key, { id: r.id, kind: e.op.slice(7) as ItemKind });
					if (r && 'id' in r && r.id) this.w.linkSession(r.id, e.op.slice(7) as ItemKind, session);
					break;
				}
				case 'attach_task':
					r = this.do(
						'attach_task',
						{
							...(resolve(e.project) ? { project: resolve(e.project) } : {}),
							...(e.milestone ? { milestone: e.milestone } : {}),
							...(resolve(e.job) ? { job: resolve(e.job) } : {}),
							reason: 'Filed by Falcon Work'
						},
						resolve(e.task),
						ik(`attach:${e.task}`)
					);
					break;
				case 'promote_to_project':
					r = this.do(
						'promote_to_project',
						{ outcome: clip(e.outcome, 12000) },
						resolve(e.task),
						ik(`promote:${e.task}`)
					);
					break;
				case 'status_line':
					if (resolve(e.item))
						r = this.do(
							'set_status_line',
							{ item: resolve(e.item), status_line: clip(e.text, 2000) },
							undefined,
							ik(`status:${e.item}`)
						);
					break;
				case 'complete': {
					const id = resolve(e.task)!;
					const t = this.w.views.task(id);
					if (!t) break;
					// Check the claim against the done-when before completing.
					const a = await this.evaluate(
						{
							state: {
								candidates: { c1: { title: t.title, done_when: t.done_when } },
								reply: e.result,
								outcomes: []
							},
							questions: { done: doneQ('c1') }
						},
						'check-done',
						agentId
					);
					if (a && (a.done ?? 0) < YES) {
						this.d.log(`clerk: completion of ${id} not confirmed (${(a.done ?? 0).toFixed(2)})`);
						break;
					}
					r = this.do(
						'complete',
						{
							content: clip(e.result, 12000),
							sources: [{ kind: 'session', ref: session, label: 'Reported in the conversation' }]
						},
						id,
						ik(`complete:${id}`)
					);
					break;
				}
				case 'wait':
					r = this.do(
						'wait',
						{
							waiting_for: clip(e.waiting_for, 12000),
							waiting_on:
								e.on === 'person'
									? { kind: 'person', ref: this.w.owner }
									: { kind: 'external', ref: clip(e.who || 'outside', 1000) },
							resume_when: e.on === 'person' ? 'The person answers' : 'What it waits on happens'
						},
						resolve(e.task),
						ik(`wait:${e.task}`)
					);
					break;
				case 'achieve_milestone':
					r = this.do(
						'achieve_milestone',
						{ basis: clip(e.basis, 12000), sources: [{ kind: 'session', ref: session }] },
						e.milestone,
						ik(`ms:${e.milestone}`)
					);
					break;
				case 'raise_question': {
					const about = resolve(e.about);
					const kind = kindOf(e.about);
					r = this.do(
						'raise_question',
						{
							prompt: clip(e.prompt, 2000),
							impact: clip(e.impact || 'The work waits on this.', 2000),
							answerable_by: [this.w.owner],
							session,
							...(about && kind ? { targets: [{ kind, id: about }] } : {})
						},
						undefined,
						ik(`q:${e.prompt.slice(0, 60)}`)
					);
					break;
				}
				case 'withdraw_question':
					r = this.do(
						'withdraw_question',
						{ reason: clip(e.reason, 1000) },
						e.question,
						ik(`wq:${e.question}`)
					);
					break;
				case 'record_answer':
					r = this.do(
						'answer',
						{
							answer: clip(e.answer, 12000),
							confidence: 'confirmed',
							sources: [{ kind: 'session', ref: session, label: 'Answered in chat' }]
						},
						e.question,
						ik(`ans:${e.question}`),
						{ kind: 'human', id: this.w.owner }
					);
					break;
				case 'finding': {
					const about = resolve(e.about);
					const kind = kindOf(e.about);
					r = this.do(
						'record_finding',
						{
							conclusion: clip(e.conclusion, 12000),
							confidence: e.confidence ?? 'supported',
							sources: [{ kind: 'session', ref: session }],
							...(about && kind ? { targets: [{ kind, id: about }] } : {})
						},
						undefined,
						ik(`f:${e.conclusion.slice(0, 60)}`)
					);
					break;
				}
				case 'entry': {
					const id = resolve(e.item);
					const kind = id ? this.w.kindOf(id) : null;
					if (
						id &&
						kind &&
						this.w.recordEntry({
							agent: `agent:${agentId}`,
							item: { id, kind },
							session,
							run: ik(`entry:${id}`),
							outcomes: [],
							summary: clip(e.summary, 2000),
							by: 'work'
						})
					)
						applied++;
					continue;
				}
			}
			if (r && r.outcome !== 'rejected' && r.outcome !== 'noop') applied++;
		}
		return applied;
	}

	/** Split a transcript into turns: each person message with the agent's last text before the next. */
	static turns(msgs: Msg[]): { request: string; reply: string; seq: number; at: string }[] {
		const out: { request: string; reply: string; seq: number; at: string }[] = [];
		for (let i = 0; i < msgs.length; i++) {
			if (msgs[i].role !== 'user' || !msgs[i].text.trim()) continue;
			let j = i + 1;
			let reply = '';
			let seq = msgs[i].seq;
			while (j < msgs.length && msgs[j].role !== 'user') {
				if (msgs[j].text.trim()) {
					reply = msgs[j].text;
					seq = msgs[j].seq;
				}
				j++;
			}
			if (reply) out.push({ request: msgs[i].text, reply, seq, at: msgs[i].at });
		}
		return out;
	}

	/**
	 * Catch-up (spec §8): read every session with activity in the window, newest first; judge its
	 * recent turns and run the writer where needed. Resumes from checkpoints after a restart.
	 */
	async catchUp(days = 14, turnsPerSession = 30, signal?: AbortSignal) {
		const since = Date.now() - days * 864e5;
		const queue: { agentId: string; sessionKey: string; sessionId?: string; updatedAt: number }[] =
			[];
		for (const agentId of this.d.agents())
			for (const s of this.d.sessions(agentId))
				if (s.updatedAt >= since && !/:heartbeat|:hook:/.test(s.sessionKey))
					queue.push({ agentId, ...s });
		queue.sort((a, b) => b.updatedAt - a.updatedAt);
		const progress = { read: 0, total: queue.length, done: false, started_at: this.w.now() };
		this.w.setMeta('catchup', JSON.stringify(progress));
		this.d.changed();
		for (const s of queue) {
			if (signal?.aborted) return;
			const cp = this.checkpoint(s.sessionKey);
			try {
				const msgs = await this.d.read(s.agentId, s.sessionKey, s.sessionId);
				const fresh = Clerk.turns(msgs.filter((m) => m.seq > (cp?.last_seq ?? 0))).slice(
					-turnsPerSession
				);
				for (const t of fresh) {
					if (signal?.aborted) return;
					await this.judgeTurn({
						agentId: s.agentId,
						session: s.sessionKey,
						run: `catchup:${s.sessionKey}:${t.seq}`,
						request: t.request,
						reply: t.reply,
						outcomes: [],
						at: new Date(t.at).toISOString(),
						seq: t.seq
					});
				}
				if (fresh.length) await this.writerPass(s.agentId, s.sessionKey, true);
			} catch (error) {
				this.d.log(`clerk: catch-up skipped ${s.sessionKey}: ${(error as Error).message}`);
			}
			progress.read++;
			this.w.setMeta('catchup', JSON.stringify(progress));
			this.d.changed();
		}
		progress.done = true;
		this.w.setMeta('catchup', JSON.stringify(progress));
		this.w.setMeta('catchup_done_at', this.w.now());
		this.d.changed();
	}

	/** Nightly (spec §3.1): writer passes for sessions left behind, then the tidy-up. */
	async nightly(signal?: AbortSignal) {
		for (const m of this.marked()) {
			if (signal?.aborted) return;
			await this.writerPass(m.agentId, m.session);
		}
		const since = Date.now() - 2 * 864e5;
		for (const agentId of this.d.agents())
			for (const s of this.d.sessions(agentId)) {
				if (signal?.aborted) return;
				if (s.updatedAt < since) continue;
				const cp = this.checkpoint(s.sessionKey);
				if (cp && Date.parse(cp.updated_at) >= s.updatedAt) continue;
				await this.writerPass(agentId, s.sessionKey, true);
			}
	}
}

export type { TurnActions };
