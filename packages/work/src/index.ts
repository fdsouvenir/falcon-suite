import {
	defineFeaturePlugin,
	type FeatureInvocationContext
} from 'openclaw/plugin-sdk/feature-plugin';
import { contract, KINDS } from './contract.js';
import { PLUGIN_ID } from './identity.js';
import type { Work } from './store/work.js';
import { currentWork, dataDir, startWork } from './plugin/runtime.js';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Actor, Envelope } from './store/types.js';
import type { Kind } from './store/engine.js';
import { outcome, raisesAsk, recordsWork } from './plugin/outcomes.js';
import { keepRecord } from './plugin/keeper.js';
import type { TurnOutcome } from './store/work.js';
import { asksThePerson } from './plugin/asks.js';
import {
	ANSWERS_THRESHOLD,
	LEFT_WAITING,
	LEFT_WAITING_THRESHOLD,
	answersDecision,
	answersQuestion,
	ASKED_FOR_THRESHOLD,
	askingPart,
	MESSAGE_SHADOW,
	RUBRIC_VERSION,
	summarise,
	turnBattery,
	decide,
	fromPerson
} from './plugin/gates.js';
import { GUIDANCE, renderBrief } from './plugin/brief.js';
import { currentHuman } from './plugin/identity.js';

/** Per-run bookkeeping for the record keeper and the end-of-turn gates (spec §10). */
type RunState = {
	/** What the turn left outside the chat, in order. */
	outcomes: TurnOutcome[];
	/** The agent recorded or corrected Work itself this turn. */
	recorded: boolean;
	asked: boolean;
	done: boolean;
	/** The person's message that started the turn, when a person started it. */
	request: string | null;
	/** What the turn was asked, whoever asked it (a subagent's task, a scheduled prompt). */
	prompt: string | null;
};

/** Provider small-model defaults OpenClaw uses when no utility model is set (concepts/models). */
const SMALL_DEFAULTS: Record<string, string> = {
	openai: 'openai/gpt-5.6-luna',
	'openai-codex': 'openai/gpt-5.6-luna',
	anthropic: 'anthropic/claude-haiku-4-5'
};

/** The Office's utility model for an agent: its own, the default, or its provider's small model. */
function utilityModel(cfg: any, agentId: string): string | null {
	const entry =
		cfg?.agents?.entries?.[agentId] ?? cfg?.agents?.list?.find?.((a: any) => a?.id === agentId);
	const set = entry?.utilityModel ?? cfg?.agents?.defaults?.utilityModel;
	if (set === '') return null;
	if (typeof set === 'string') return set;
	const primary = entry?.model ?? cfg?.agents?.defaults?.model;
	const ref = typeof primary === 'string' ? primary : primary?.primary;
	return typeof ref === 'string' ? (SMALL_DEFAULTS[ref.split('/')[0]] ?? null) : null;
}

/** Who is calling: the agent behind a tool call, or the signed-in person behind the Control UI. */
function actorFor(context: FeatureInvocationContext): Actor {
	if (context.source === 'tool') {
		const agentId = context.tool.agentId;
		if (!agentId) throw new Error('Falcon Work needs the calling agent');
		return { kind: 'agent', id: `agent:${agentId}` };
	}
	const human = currentHuman();
	if (human) return human;
	// The Gateway only admits operator connections with the operation's scope to a plugin session
	// action, so a caller that reached here is a signed-in operator even when the request scope does
	// not expose the connection (as with paired browsers on OpenClaw 2026.9.6). Work is shared per
	// Gateway, so that operator is the Gateway owner.
	if (context.source === 'session-action') {
		const scopes = context.action.client?.scopes ?? [];
		if (scopes.some((s) => s.startsWith('operator.')))
			return { kind: 'human', id: 'person:gateway-owner' };
	}
	throw new Error('Falcon Work needs a signed-in person');
}

/** A retried tool call carries the same id, so its key makes the retry a no-op. */
function envelopeFor(
	e: {
		command: string;
		id?: string;
		expected_version?: number;
		idempotency_key?: string;
		input?: Record<string, unknown>;
	},
	context: FeatureInvocationContext,
	suffix = ''
): Envelope {
	return {
		...e,
		idempotency_key:
			e.idempotency_key ??
			(context.source === 'tool' ? `tool:${context.toolCallId}${suffix}` : undefined)
	};
}

const invalid = (reason: string) => ({
	outcome: 'rejected' as const,
	code: 'invalid_input',
	reason
});

/** `person:x`, `agent:x`, a Task id, or anything else (external). */
function waitingOn(w: Work, ref: unknown) {
	const r = typeof ref === 'string' ? ref : '';
	if (r.startsWith('person:')) return { kind: 'person', ref: r };
	if (r.startsWith('agent:')) return { kind: 'agent', ref: r };
	if (r && (w.reads.get(r) as { kind?: string } | null)?.kind === 'task')
		return { kind: 'work', ref: r };
	return { kind: 'external', ref: r || 'unspecified' };
}

/** Ids of the things a Question, Decision or Finding is about, with their kinds. */
function targetsFor(
	w: Work,
	ids: unknown
): { list: { kind: string; id: string }[] } | { error: string } {
	const list: { kind: string; id: string }[] = [];
	for (const id of (ids as string[] | undefined) ?? []) {
		const kind = (w.reads.get(id) as { kind?: string } | null)?.kind;
		if (!kind || !['objective', 'project', 'milestone', 'task'].includes(kind))
			return { error: `about: ${id} is not a Task, Project, Milestone or Objective` };
		list.push({ kind, id });
	}
	return { list };
}

const feature = defineFeaturePlugin({
	contract,
	name: 'Falcon Work',
	description: 'A record of what your agents do, why, and what needs you.',
	setup(api, events) {
		const runs = new Map<string, RunState>();
		const lastBrief = new Map<string, string>();

		const ready = (): Work => currentWork();
		/** Hooks never throw: if the store cannot open, the turn goes on without Work. */
		const maybe = (): Work | null => {
			try {
				return currentWork();
			} catch (error) {
				api.logger?.warn?.(`Falcon Work unavailable: ${(error as Error).message}`);
				return null;
			}
		};
		const runState = (id: string | undefined): RunState | null => {
			if (!id) return null;
			let state = runs.get(id);
			if (!state) {
				state = {
					outcomes: [],
					recorded: false,
					asked: false,
					done: false,
					request: null,
					prompt: null
				};
				runs.set(id, state);
				if (runs.size > 500) runs.delete(runs.keys().next().value as string);
			}
			return state;
		};

		api.registerService({
			id: PLUGIN_ID,
			async start(ctx) {
				// Feature plugins take no config in this SDK, so the location and owner are fixed.
				startWork(ctx.stateDir);
			}
			// No stop: the store is shared with the registration that replaces this one.
		});

		// The guidance (static, so it caches) and the agent's brief, every turn (spec §10).
		/** The agent's last reply per session: what the person's next message answers. */
		const lastReply = new Map<string, string>();
		/** One-off lines for the agent's next brief in a session (captured asks, reminders). */
		const notes = new Map<string, string[]>();
		const note = (session: string, line: string) =>
			notes.set(session, [...(notes.get(session) ?? []), line].slice(-5));
		const decisions = () =>
			(api as unknown as { runtime?: { decisions?: Parameters<typeof decide>[0] } }).runtime
				?.decisions;
		const log = (line: string) => api.logger?.info?.(`Falcon Work ${line}`);
		const changed = (w: Work) => {
			try {
				events.emit('changed', { at: w.now() });
			} catch {
				/* best effort */
			}
		};

		// The guidance (static, so it caches) and the agent's brief, every turn (spec §10).
		api.on('before_prompt_build', (event, ctx) => {
			const work = ctx.agentId ? maybe() : null;
			if (!work || !ctx.agentId) return { prependSystemContext: GUIDANCE };
			const agent = `agent:${ctx.agentId}`;
			const key = ctx.sessionKey ?? agent;
			const now = work.now();
			const message =
				(event as { currentUserMessage?: string }).currentUserMessage ?? event.prompt ?? '';
			const person = fromPerson(ctx as never, message);
			if (!person)
				log(
					`gates skipped: not a person turn (trigger ${ctx.trigger ?? '-'}, provenance ${(ctx as { inputProvenance?: { kind?: string } }).inputProvenance?.kind ?? '-'})`
				);
			const state = runState(ctx.runId);
			if (state && person) state.request = message;
			if (state && !state.prompt && message.trim()) state.prompt = message;
			if (person) void matchAnswers(work, key, message, ctx.runId ?? now);
			const extra = notes.get(key) ?? [];
			notes.delete(key);
			const current = work.sessionTask(ctx.sessionKey);
			const brief = renderBrief(
				work.reads,
				agent,
				lastBrief.get(key) ?? null,
				now,
				current ? { id: current, title: work.reads.taskTitle(current) } : null
			);
			lastBrief.set(key, now);
			return {
				prependSystemContext: GUIDANCE,
				prependContext: extra.length ? `${brief}\n${extra.join('\n')}` : brief
			};
		});

		/** Gate answers_open_item: record the person's chat reply against what is open for them. */
		/**
		 * Every decision-model answer is logged with what it acted on, so shadow questions can be
		 * reviewed and labelled before they are allowed to act. One JSON line per event, in Work's
		 * own data folder; rotated at 5 MB.
		 */
		function logDecisions(entry: Record<string, unknown>) {
			try {
				const dir = dataDir();
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				const file = path.join(dir, 'decisions.jsonl');
				if (existsSync(file) && statSync(file).size > 5_000_000)
					renameSync(file, path.join(dir, 'decisions.1.jsonl'));
				appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
			} catch (error) {
				log(`decision log failed: ${(error as Error).message}`);
			}
		}

		/** The person's message: answers to what is open for them, and (shadow) what kind it is. */
		async function matchAnswers(w: Work, session: string, message: string, runId: string) {
			const open = w.views.overview(w.owner, w.now()).needs_you;
			const items = [
				...open.questions.map((q) => ({
					id: q.id,
					kind: 'question' as const,
					prompt: q.prompt,
					version: q.version
				})),
				...open.decisions.map((d) => ({
					id: d.id,
					kind: 'decision' as const,
					prompt: d.prompt,
					version: d.version,
					options: Object.fromEntries(
						(d.options as { id: string; label: string }[]).map((o) => [o.id, o.label])
					),
					recommendation: (d.recommendation as { option?: string } | null)?.option ?? null
				}))
			].slice(0, 20);
			const open_items: Record<string, unknown> = {};
			const questions: Record<string, unknown> = { ...MESSAGE_SHADOW };
			items.forEach((it, n) => {
				if (it.kind === 'question') {
					open_items[it.id] = { n: n + 1, prompt: it.prompt };
					questions[it.id] = answersQuestion(it.id);
				} else {
					open_items[it.id] = {
						n: n + 1,
						prompt: it.prompt,
						options: it.options,
						recommendation: it.recommendation
					};
					questions[it.id] = answersDecision(it.id, it.options);
				}
			});
			const answers = await decide(
				decisions(),
				{
					state: {
						previous_reply: (lastReply.get(session) ?? '').slice(-2000),
						message,
						open_items
					},
					questions
				},
				'message',
				undefined,
				log
			);
			if (!answers) return;
			const human = { kind: 'human' as const, id: w.owner };
			const acted: string[] = [];
			for (const it of items) {
				const a = answers[it.id];
				if (
					it.kind === 'question' &&
					a?.type === 'boolean' &&
					a.probabilityTrue >= ANSWERS_THRESHOLD
				) {
					const r = w.do(
						{
							command: 'answer',
							id: it.id,
							idempotency_key: `gate-answer:${runId}:${it.id}`,
							input: {
								answer: message.slice(0, 12000),
								confidence: 'confirmed',
								sources: [{ kind: 'session', ref: session, label: 'Answered in chat' }]
							}
						},
						human
					);
					if (r.outcome !== 'rejected') acted.push(`answered ${it.id}`);
				}
				if (
					it.kind === 'decision' &&
					a?.type === 'choice' &&
					a.choice !== 'not_decided' &&
					(a.probabilities?.[a.choice] ?? 0) >= ANSWERS_THRESHOLD
				) {
					const r = w.do(
						{
							command: 'decide',
							id: it.id,
							idempotency_key: `gate-decide:${runId}:${it.id}`,
							input: { option: a.choice, rationale: `Decided in chat: ${message.slice(0, 1900)}` }
						},
						human
					);
					if (r.outcome !== 'rejected') acted.push(`decided ${it.id} ${a.choice}`);
				}
			}
			logDecisions({
				at: w.now(),
				event: 'message',
				rubric: RUBRIC_VERSION,
				session,
				run: runId,
				message: message.slice(0, 600),
				answers: summarise(answers, []),
				acted
			});
			if (acted.length) changed(w);
		}

		/**
		 * The end of a turn the person started: one batch for everything Work wants to know about it.
		 * Measured questions act (left_waiting, and the pieces that are the ask); shadow ones are logged.
		 */
		async function captureTurn(
			w: Work,
			agentId: string,
			session: string,
			request: string,
			reply: string,
			runId: string,
			askedInWork: boolean
		) {
			const agent = `agent:${agentId}`;
			const inProgress = w.reads.brief(agent, null, w.now()).in_progress;
			const task = inProgress[0] ?? null;
			const doneWhen = task
				? ((w.reads.get(task.id) as { definition?: { done_when?: string } } | null)?.definition
						?.done_when ?? '')
				: '';
			const openQuestions = w.views
				.overview(w.owner, w.now())
				.needs_you.questions.map((q) => ({ id: q.id, prompt: q.prompt }));
			const { pieces, pieceIds, openIds, batch } = turnBattery({
				request,
				reply,
				task: task ? { title: task.title, done_when: doneWhen } : null,
				tasks: inProgress.map((t) => ({ id: t.id, title: t.title })),
				open: openQuestions
			});
			const answers = await decide(decisions(), batch, 'turn', agentId, log);
			if (!answers) {
				// No decision model: the plain text check, as a reminder only.
				if (!askedInWork && asksThePerson(reply))
					note(
						session,
						'Your last reply asked the person for something that is not in Falcon Work. If the work depends on it, record it with falcon_work_ask so it stays under Needs you.'
					);
				return;
			}
			const acted: string[] = [];
			const a = answers.left_waiting;
			const outcome = a?.type === 'choice' ? String(a.choice) : 'nothing';
			const waiting =
				!askedInWork &&
				outcome.startsWith('needs_') &&
				(a.probabilities?.[outcome] ?? 0) >= LEFT_WAITING_THRESHOLD;
			let prompt = '';
			if (waiting) {
				const picked = pieces.filter((_, n) => {
					const p = answers[pieceIds[n]];
					return p?.type === 'boolean' && p.probabilityTrue >= ASKED_FOR_THRESHOLD;
				});
				prompt = picked.length ? picked.map((p) => p.text).join('\n') : askingPart(reply);
				if (prompt.length > 1900) prompt = prompt.slice(0, 1899) + '…';
				const kind =
					outcome === 'needs_decision'
						? 'a decision'
						: outcome === 'needs_action'
							? 'an action'
							: 'an answer';
				const r = w.do(
					{
						command: 'raise_question',
						idempotency_key: `gate-capture:${runId}`,
						input: {
							prompt,
							impact: `Asked in chat; captured by Falcon Work because the reply needs ${kind} from you.`,
							answerable_by: [w.owner],
							...(task ? { targets: [{ kind: 'task', id: task.id }] } : {})
						}
					},
					{ kind: 'agent', id: agent }
				);
				if (r.outcome !== 'rejected') {
					acted.push(`captured ${(r as { id?: string }).id}`);
					if (outcome === 'needs_action' && task) {
						w.do(
							{
								command: 'wait',
								id: task.id,
								idempotency_key: `gate-wait:${runId}`,
								input: {
									waiting_for: prompt.slice(0, 2000),
									waiting_on: { kind: 'person', ref: w.owner },
									resume_when: 'The person has done it and said so'
								}
							},
							{ kind: 'agent', id: agent }
						);
						acted.push(`waiting ${task.id}`);
					}
					note(
						session,
						`Falcon Work captured what your last reply asked of the person as a Question (${(r as { id?: string }).id}). Refine it, split it into separate Questions with falcon_work_ask, or withdraw it if the work does not depend on it.`
					);
				}
			}
			log(
				`decisions at end of turn: left_waiting ${outcome} ${(a?.probabilities?.[outcome] ?? 0).toFixed(2)}${acted.length ? ` → ${acted.join(', ')}` : ''}`
			);
			logDecisions({
				at: w.now(),
				event: 'turn',
				rubric: RUBRIC_VERSION,
				session,
				run: runId,
				request: request.slice(0, 300),
				reply_end: reply.slice(-1000),
				asked_in_work: askedInWork,
				answers: summarise(answers, pieceIds),
				already_open_id:
					answers.already_open?.choice && answers.already_open.choice !== 'none'
						? (openIds.find(([k]) => k === answers.already_open.choice)?.[1] ?? null)
						: null,
				pieces_picked: pieceIds.filter(
					(id) => (answers[id]?.probabilityTrue ?? 0) >= ASKED_FOR_THRESHOLD
				),
				acted
			});
			if (acted.length) changed(w);
		}

		// What the turn left outside the chat (spec §10, The record keeper). Tool calls themselves
		// are not kept: the session transcript has them.
		api.on('after_tool_call', (event, ctx) => {
			if (!ctx.agentId) return;
			const state = runState(event.runId ?? ctx.runId);
			if (!state) return;
			const params = (event.params ?? {}) as Record<string, unknown>;
			if (!event.error && raisesAsk(event.toolName, params)) state.asked = true;
			if (!event.error && recordsWork(event.toolName)) {
				state.recorded = true;
				return;
			}
			const e = event as typeof event & {
				toolKind?: string;
				toolInputKind?: string;
				result?: unknown;
			};
			const c = ctx as { toolKind?: string; toolInputKind?: string };
			const kind =
				e.toolKind ??
				c.toolKind ??
				(e.toolInputKind || c.toolInputKind ? 'code_mode_exec' : undefined);
			const o = outcome(event.toolName, params, {
				error: event.error,
				toolKind: kind,
				result: e.result
			});
			if (o) state.outcomes.push(o);
		});

		// A subagent works under the Task of the session that spawned it.
		api.on('subagent_spawned', (_event, ctx) => {
			const c = ctx as { childSessionKey?: string; requesterSessionKey?: string };
			if (!c.childSessionKey || !c.requesterSessionKey) return;
			maybe()?.setParent(c.childSessionKey, c.requesterSessionKey);
		});

		type Llm = { complete?: (p: unknown) => Promise<{ text: string }> };
		/** The utility model writes the record's words; never the agent's main model. */
		const writer = (agentId: string) => {
			const model = utilityModel((api as { config?: unknown }).config, agentId);
			const llm = (api as unknown as { runtime?: { llm?: Llm } }).runtime?.llm;
			if (!model || !llm?.complete) return undefined;
			return async (prompt: string) =>
				(
					await llm.complete!({
						messages: [{ role: 'user', content: prompt }],
						model,
						maxTokens: 600,
						temperature: 0.2,
						purpose: 'falcon-work.record'
					})
				).text;
		};

		// At the end of every turn: the record keeper files what changed; on turns the person started,
		// the gates catch what the reply leaves waiting on them.
		api.on('before_agent_finalize', (event, ctx) => {
			if (event.stopHookActive) return;
			const state = runState(event.runId);
			const reply = event.lastAssistantMessage ?? '';
			const session = ctx?.sessionKey ?? event.sessionKey ?? '';
			const work = ctx?.agentId ? maybe() : null;
			if (work && ctx?.agentId && state?.request && reply)
				void captureTurn(
					work,
					ctx.agentId,
					session,
					state.request,
					reply,
					event.runId ?? work.now(),
					state.asked
				);
			if (session && reply) lastReply.set(session, reply);
			if (!work || !ctx?.agentId || !state || state.done) return;
			state.done = true;
			const agentId = ctx.agentId;
			void keepRecord(
				work,
				{
					agentId,
					session: session || null,
					run: event.runId ?? work.now(),
					request: state.request ?? state.prompt,
					reply,
					outcomes: state.outcomes,
					person: !!state.request,
					agentRecorded: state.recorded
				},
				{ decisions: decisions(), write: writer(agentId), log, logDecisions }
			)
				.then((r) => {
					if (r.acted.length) changed(work);
				})
				.catch((error) => log(`record keeper failed: ${(error as Error).message}`));
		});

		/** Run one command; tell open pages a change happened (best effort: it is already committed). */
		const commit = (w: Work, envelope: Envelope, actor: Actor) => {
			const outcome = w.do(envelope, actor);
			if (outcome.outcome !== 'rejected' && outcome.outcome !== 'noop')
				try {
					events.emit('changed', { at: w.now() });
				} catch (error) {
					api.logger?.warn?.(`Falcon Work change notice failed: ${(error as Error).message}`);
				}
			return outcome;
		};

		return {
			read(input, context) {
				const w = ready();
				const f = input.filters ?? {};
				switch (input.view) {
					case 'overview':
						return w.views.overview(actorFor(context).id, w.now());
					case 'areas':
						return w.views.areas(actorFor(context).id, f.area);
					case 'project':
						return input.id
							? (w.views.project(input.id, actorFor(context).id) ?? { error: 'not_found' })
							: { error: 'id_required' };
					case 'objective':
						return input.id
							? (w.views.objective(input.id, actorFor(context).id) ?? { error: 'not_found' })
							: { error: 'id_required' };
					case 'panel':
						return input.id
							? (w.views.panel(input.id, actorFor(context).id) ?? { error: 'not_found' })
							: { error: 'id_required' };
					case 'feed':
						return w.views.feed({
							filter: f.feed,
							agent: f.agent,
							limit: f.limit,
							before: f.before
						});
					case 'brief': {
						const actor = actorFor(context);
						return actor.kind === 'agent'
							? w.reads.brief(actor.id, null, w.now())
							: w.reads.needsYou(actor.id, w.now());
					}
					case 'needs_you':
						return w.reads.needsYou(actorFor(context).id, w.now());
					case 'objectives':
						// The tab's shape: what serves each Objective comes with its Task counts.
						return w.views.objectivesTab(!!f.include_inactive);
					case 'get':
						return input.id
							? (w.reads.get(input.id) ?? { error: 'not_found' })
							: { error: 'id_required' };
					case 'list':
						return input.kind && (KINDS as readonly string[]).includes(input.kind)
							? w.reads.list(input.kind as Kind, f)
							: { error: 'kind_required' };
					case 'timeline':
						return w.reads.timeline({
							task: f.task,
							session: f.session,
							unfiled: f.unfiled,
							agent: f.agent,
							limit: f.limit,
							before: f.before
						});
					case 'warnings':
						return w.reads.warnings(w.now());
					case 'help':
						return input.command
							? (w.help(input.command) ?? { error: 'unknown_command' })
							: { commands: w.catalog() };
				}
				return { error: 'unknown_view' };
			},
			do(input, context) {
				const w = ready();
				return commit(w, envelopeFor(input, context), actorFor(context));
			},
			plan(input, context) {
				const w = ready();
				const i = input as any;
				if (!!i.project === !!i.new_project)
					return invalid('Give project (an existing Project id) or new_project, not both');
				const plan = { milestones: i.milestones, tasks: i.tasks };
				return commit(
					w,
					envelopeFor(
						i.project
							? { command: 'plan_project', id: i.project, input: plan }
							: { command: 'create_project', input: { ...i.new_project, ...plan } },
						context
					),
					actorFor(context)
				);
			},
			task(input, context) {
				const w = ready();
				const actor = actorFor(context);
				const i = input as any;
				const on = (command: string, body: Record<string, unknown>) =>
					commit(w, envelopeFor({ command, id: i.id, input: body }, context), actor);
				switch (i.action) {
					case 'create': {
						const fields: Record<string, unknown> = {};
						for (const k of [
							'title',
							'description',
							'done_when',
							'area',
							'project',
							'milestone',
							'serves',
							'decision',
							'depends_on',
							'plan'
						])
							if (i[k] !== undefined) fields[k] = i[k];
						const created = commit(
							w,
							envelopeFor({ command: 'create_task', input: fields }, context),
							actor
						);
						if (!i.start || !('id' in created) || !created.id) return created;
						if (context.source === 'tool' && context.tool.sessionKey)
							w.setSessionTask(context.tool.sessionKey, created.id);
						const started = commit(
							w,
							envelopeFor(
								{ command: 'start', id: created.id, input: { claim: true } },
								context,
								':start'
							),
							actor
						);
						return { ...created, started: started.outcome };
					}
					case 'start': {
						const r = on('start', { claim: true });
						if (r.outcome !== 'rejected' && context.source === 'tool' && context.tool.sessionKey)
							w.setSessionTask(context.tool.sessionKey, i.id);
						return r;
					}
					case 'wait':
						if (!i.waiting_on) return invalid('wait: say who or what it waits on (waiting_on)');
						return on('wait', {
							waiting_for: i.waiting_for,
							waiting_on: waitingOn(w, i.waiting_on),
							resume_when: i.resume_when,
							...(i.follow_up_at ? { follow_up_at: i.follow_up_at } : {})
						});
					case 'resume':
						return on('resume', {});
					case 'complete':
						return on('complete', {
							content: i.result,
							...(i.evidence?.length ? { sources: i.evidence } : {})
						});
					case 'abandon':
						return on('abandon', { reason: i.reason ?? 'No longer needed' });
				}
				return invalid('Unknown action');
			},
			ask(input, context) {
				const w = ready();
				const actor = actorFor(context);
				const i = input as any;
				const holds: string[] = i.holds ?? [];
				const targets = targetsFor(w, [...new Set([...(i.about ?? []), ...holds])]);
				if ('error' in targets) return invalid(targets.error);
				for (const id of holds)
					if ((w.reads.get(id) as { kind?: string } | null)?.kind !== 'task')
						return invalid(`holds: ${id} is not a Task`);
				const to: string[] = i.to?.length ? i.to : [w.owner];
				const about = targets.list.length ? { targets: targets.list } : {};
				const asks =
					i.kind === 'question'
						? (
								i.questions ?? [{ prompt: i.prompt, impact: i.impact, hypothesis: i.hypothesis }]
							).map((q: any) => ({
								command: 'raise_question',
								input: {
									prompt: q.prompt,
									impact: q.impact,
									answerable_by: to,
									...(q.hypothesis ? { hypothesis: q.hypothesis } : {}),
									...about
								}
							}))
						: [
								{
									command: 'raise_decision',
									input: {
										prompt: i.prompt,
										options: i.options,
										recommendation: i.recommendation,
										deciders: to,
										consequence_of_no_decision: i.consequence_of_no_decision,
										...about
									}
								}
							];
				const raised: { id: string; prompt: string }[] = [];
				for (const [n, a] of asks.entries()) {
					const r = commit(w, envelopeFor(a, context, n ? `:${n}` : ''), actor);
					if (r.outcome === 'rejected')
						return raised.length ? { ...r, raised_before_rejection: raised } : r;
					raised.push({ id: (r as { id: string }).id, prompt: a.input.prompt });
				}
				const who = to[0];
				const held = holds.map((id) =>
					commit(
						w,
						envelopeFor(
							{
								command: 'wait',
								id,
								input: {
									waiting_for:
										raised.length === 1
											? `${i.kind === 'question' ? 'Answer' : 'Decision'}: ${raised[0].prompt}`
											: `Answers: ${raised.map((x) => x.prompt).join(' · ')}`,
									waiting_on: { kind: who.startsWith('agent:') ? 'agent' : 'person', ref: who },
									resume_when:
										i.kind === 'question' ? 'Answered in Falcon Work' : 'Decided in Falcon Work'
								}
							},
							context,
							`:hold:${id}`
						),
						actor
					)
				);
				return {
					outcome: 'committed',
					...(raised.length === 1 ? { id: raised[0].id } : {}),
					[i.kind === 'question' ? 'questions' : 'decision']:
						i.kind === 'question' ? raised.map((x) => x.id) : raised[0].id,
					...(holds.length
						? { held: holds.map((id, n) => ({ id, outcome: held[n].outcome })) }
						: {})
				};
			},
			finding(input, context) {
				const w = ready();
				const i = input as any;
				const targets = targetsFor(w, i.about);
				if ('error' in targets) return invalid(targets.error);
				return commit(
					w,
					envelopeFor(
						{
							command: 'record_finding',
							input: {
								conclusion: i.conclusion,
								confidence: i.confidence,
								sources: i.evidence,
								...(targets.list.length ? { targets: targets.list } : {})
							}
						},
						context
					),
					actorFor(context)
				);
			}
		};
	}
});

export default feature;
