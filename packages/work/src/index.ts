import {
	defineFeaturePlugin,
	type FeatureInvocationContext
} from 'openclaw/plugin-sdk/feature-plugin';
import * as transcripts from 'openclaw/plugin-sdk/session-transcript-runtime';
import { contract as base } from './contract.js';
import { PLUGIN_ID } from './identity.js';
import type { Work, TurnOutcome } from './store/work.js';
import { currentWork, dataDir, startWork } from './plugin/runtime.js';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Actor, Envelope } from './store/types.js';
import { outcome } from './plugin/outcomes.js';
import { currentHuman } from './plugin/identity.js';
import { Clerk, type Msg } from './clerk/clerk.js';

/** How long a session stays quiet before the writer looks at it (spec §3.1). */
const IDLE_MS = 10 * 60 * 1000;

type RunState = {
	outcomes: TurnOutcome[];
	request: string | null;
	prompt: string | null;
	done: boolean;
};

/** Did a person start this turn? Heartbeats, jobs and other sessions are not the person. */
function fromPerson(
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

/** Who is calling: the agent behind a tool call, or the signed-in person behind the Control UI. */
function actorFor(context: FeatureInvocationContext): Actor {
	if (context.source === 'tool') {
		const agentId = context.tool.agentId;
		if (!agentId) throw new Error('Falcon Work needs the calling agent');
		return { kind: 'agent', id: `agent:${agentId}` };
	}
	const human = currentHuman();
	if (human) return human;
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
	if (r && w.kindOf(r) === 'task') return { kind: 'work', ref: r };
	return { kind: 'external', ref: r || 'unspecified' };
}

/** Ids of the things a Question, Decision or Finding is about, with their kinds. */
function targetsFor(
	w: Work,
	ids: unknown
): { list: { kind: string; id: string }[] } | { error: string } {
	const list: { kind: string; id: string }[] = [];
	for (const id of (ids as string[] | undefined) ?? []) {
		const kind =
			w.kindOf(id) ??
			(w.db.prepare('SELECT 1 FROM milestone WHERE id = ?').get(id) ? 'milestone' : null);
		if (!kind) return { error: `about: ${id} is not a Job, Project, Milestone or Task` };
		list.push({ kind, id });
	}
	return { list };
}

const textOf = (content: unknown): string =>
	typeof content === 'string'
		? content
		: Array.isArray(content)
			? content
					.filter((p) => p?.type === 'text' && typeof p.text === 'string')
					.map((p) => p.text)
					.join('\n')
			: '';

const feature = defineFeaturePlugin({
	contract: base,
	name: 'Falcon Work',
	description: 'A record of what your agents do for you, kept from your conversations.',
	setup(api, events) {
		const runs = new Map<string, RunState>();
		const runtime = api.runtime as any;
		const log = (line: string) => api.logger?.info?.(`Falcon Work ${line}`);
		const maybe = (): Work | null => {
			try {
				return currentWork();
			} catch (error) {
				api.logger?.warn?.(`Falcon Work unavailable: ${(error as Error).message}`);
				return null;
			}
		};
		const changed = () => {
			try {
				events.emit('changed', { at: new Date().toISOString() });
			} catch {
				/* best effort */
			}
		};
		const runState = (id: string | undefined): RunState | null => {
			if (!id) return null;
			let s = runs.get(id);
			if (!s) {
				s = { outcomes: [], request: null, prompt: null, done: false };
				runs.set(id, s);
				if (runs.size > 500) runs.delete(runs.keys().next().value as string);
			}
			return s;
		};

		/** Every judgment and writer pass, logged for review and labelling; rotated at 5 MB. */
		function logDecision(entry: Record<string, unknown>) {
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

		const agents = (): string[] => {
			const cfg = (api as { config?: any }).config;
			const ids = new Set<string>();
			for (const a of cfg?.agents?.list ?? []) if (a?.id) ids.add(a.id);
			for (const id of Object.keys(cfg?.agents?.entries ?? {})) ids.add(id);
			if (!ids.size) ids.add('main');
			return [...ids];
		};

		let clerk: Clerk | null = null;
		const getClerk = (): Clerk | null => {
			const work = maybe();
			if (!work) return null;
			if (clerk && (clerk as any).d.work === work) return clerk;
			clerk = new Clerk({
				work,
				decisions: () => runtime?.decisions,
				complete: runtime?.subagent?.complete
					? async (agentId, system, message) =>
							(
								await runtime.subagent.complete({
									agentId,
									message,
									extraSystemPrompt: system,
									timeoutMs: 120_000
								})
							).text
					: undefined,
				sessions: (agentId) => {
					const out: { sessionKey: string; sessionId?: string; updatedAt: number }[] = [];
					try {
						for (const { sessionKey, entry } of runtime.agent.session.listSessionEntries({
							agentId
						}))
							out.push({
								sessionKey,
								sessionId: entry?.sessionId,
								updatedAt: entry?.updatedAt ?? 0
							});
					} catch (error) {
						log(`could not list sessions for ${agentId}: ${(error as Error).message}`);
					}
					return out.sort((a, b) => b.updatedAt - a.updatedAt);
				},
				read: async (agentId, sessionKey, sessionId) => {
					let id = sessionId;
					// The transcript reader needs the session's current id; look it up when not given.
					if (!id)
						try {
							for (const { sessionKey: key, entry } of runtime.agent.session.listSessionEntries({
								agentId
							}))
								if (key === sessionKey) {
									id = entry?.sessionId;
									break;
								}
						} catch {
							/* fall through */
						}
					if (!id) throw new Error(`no session id for ${sessionKey}`);
					const out: any = await transcripts.readVisibleSessionTranscriptMessageEntries({
						agentId,
						sessionKey,
						sessionId: id
					});
					const list: any[] = Array.isArray(out) ? out : (out?.entries ?? []);
					return list
						.map((e): Msg | null => {
							const role = e?.message?.role ?? e?.role;
							if (role !== 'user' && role !== 'assistant') return null;
							return {
								seq: Number(e.seq ?? 0),
								role,
								text: textOf(e?.message?.content ?? e?.content),
								at: String(e.createdAt ?? e.message?.timestamp ?? '')
							};
						})
						.filter((m): m is Msg => !!m);
				},
				agents,
				names: (agentId, sessionKey) => {
					const cfg = (api as { config?: any }).config;
					const a =
						(cfg?.agents?.list ?? []).find((x: any) => x?.id === agentId) ??
						cfg?.agents?.entries?.[agentId];
					const agent: string =
						a?.identity?.name ?? a?.name ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
					let person: string | null = null;
					try {
						for (const { sessionKey: key, entry } of runtime.agent.session.listSessionEntries({
							agentId
						}))
							if (key === sessionKey) {
								const actor = entry?.createdActor ?? entry?.owner?.actor;
								if (actor?.type === 'human') {
									const project = transcripts.createSessionCatalogSourceActorProjector?.({
										pluginId: PLUGIN_ID,
										sourceDomain: PLUGIN_ID,
										actors: [actor]
									});
									person = project?.(actor)?.label ?? actor.label ?? null;
								}
								break;
							}
					} catch {
						/* unknown: the writer names nobody */
					}
					return { agent, person };
				},
				log,
				logDecision,
				changed
			});
			return clerk;
		};

		// The service owns the clerk's background work (spec §3.1, §8).
		let schedule: ((id: string, delayMs: number, run: () => Promise<unknown>) => void) | null =
			null;
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const later = (id: string, delayMs: number, run: () => Promise<unknown>) => {
			if (schedule) return schedule(id, delayMs, run);
			clearTimeout(timers.get(id));
			const timer = setTimeout(() => {
				timers.delete(id);
				run().catch((e) => log(`${id} failed: ${(e as Error).message}`));
			}, delayMs);
			// Background bookkeeping never keeps the Gateway process alive on its own.
			timer.unref?.();
			timers.set(id, timer);
		};

		api.registerService({
			id: PLUGIN_ID,
			apiVersion: 2,
			start(ctx: any) {
				const work = startWork(ctx.stateDir);
				if (ctx.scheduler?.schedule)
					schedule = (id, delayMs, run) =>
						void ctx.scheduler.schedule({
							id,
							delayMs,
							run: () => run().catch((e: Error) => log(`${id} failed: ${e.message}`))
						});
				// First start of 2.0: catch up on the last 14 days, whether or not anyone opens the page.
				const catchup = work.meta('catchup');
				if (!catchup || !JSON.parse(catchup).done)
					later('catch-up', 20_000, async () => {
						log('catch-up started');
						await getClerk()?.catchUp(14, 30, ctx.scheduler?.signal);
						log('catch-up finished');
					});
				// Sessions left marked for the writer (a restart, a failed pass) are picked up soon after start.
				later('sweep-marked', 90_000, async () => {
					const c = getClerk();
					if (!c) return;
					for (const m of c.marked()) await c.writerPass(m.agentId, m.session);
				});
				// Hourly: the nightly sweep runs once a day, at night.
				later('nightly-check', 60 * 60 * 1000, async function check() {
					const w = maybe();
					const hour = new Date().getHours();
					const last = w?.meta('nightly_at');
					if (
						w &&
						hour >= 2 &&
						hour < 5 &&
						(!last || Date.now() - Date.parse(last) > 20 * 3600 * 1000)
					) {
						w.setMeta('nightly_at', w.now());
						await getClerk()?.nightly(ctx.scheduler?.signal);
					}
					later('nightly-check', 60 * 60 * 1000, check);
				});
			},
			stop() {
				for (const t of timers.values()) clearTimeout(t);
				timers.clear();
			}
		} as any);

		// Observe the person's message: the request a turn answers, and answers to Needs you.
		api.on('before_prompt_build', (event, ctx) => {
			const message =
				(event as { currentUserMessage?: string }).currentUserMessage ?? event.prompt ?? '';
			const state = runState(ctx.runId);
			if (state && !state.prompt && message.trim()) state.prompt = message;
			if (!fromPerson(ctx as never, message)) return;
			if (state) state.request = message;
			if (ctx.agentId && ctx.sessionKey) {
				const agentId = ctx.agentId;
				const session = ctx.sessionKey;
				later(`answers:${ctx.runId ?? session}`, 0, async () =>
					getClerk()?.checkAnswers(agentId, session, message, ctx.runId ?? session)
				);
			}
		});

		// What the turn left outside the chat (spec §3.2). Raw tool calls are not kept.
		api.on('after_tool_call', (event, ctx) => {
			if (!ctx.agentId) return;
			const state = runState(event.runId ?? ctx.runId);
			if (!state) return;
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
			const o = outcome(event.toolName, (event.params ?? {}) as Record<string, unknown>, {
				error: event.error,
				toolKind: kind,
				result: e.result
			});
			if (o) state.outcomes.push(o);
		});

		// End of a turn: hand it to the clerk on the service's scheduler (no model calls in the hook),
		// and arm the session's idle timer for the writer.
		api.on('agent_end', (event, ctx) => {
			const runId = event.runId ?? ctx?.runId;
			const state = runState(runId);
			if (!state || state.done || !ctx?.agentId || !ctx.sessionKey) return;
			state.done = true;
			const messages = (event.messages ?? []) as { role?: string; content?: unknown }[];
			const reply =
				[...messages]
					.reverse()
					.map((m) => (m.role === 'assistant' ? textOf(m.content) : ''))
					.find((t) => t.trim()) ?? '';
			const agentId = ctx.agentId;
			const session = ctx.sessionKey;
			const turn = {
				agentId,
				session,
				run: runId ?? `${session}:${Date.now()}`,
				request: state.request ?? state.prompt,
				reply,
				outcomes: state.outcomes
			};
			if (!event.success || !reply) return;
			later(`turn:${turn.run}`, 0, async () => getClerk()?.judgeTurn(turn));
			later(`idle:${session}`, IDLE_MS, async () => getClerk()?.writerPass(agentId, session));
		});

		// A subagent's session is its own; nothing to link (the clerk reads every session).
		api.on('before_compaction', (_event, ctx) => {
			const c = ctx as { agentId?: string; sessionKey?: string };
			if (c.agentId && c.sessionKey) {
				const agentId = c.agentId;
				const session = c.sessionKey;
				later(`compact:${session}`, 0, async () => getClerk()?.writerPass(agentId, session));
			}
		});
		api.on('session_end', (_event, ctx) => {
			const c = ctx as { agentId?: string; sessionKey?: string };
			if (c.agentId && c.sessionKey) {
				const agentId = c.agentId;
				const session = c.sessionKey;
				later(`end:${session}`, 0, async () => getClerk()?.writerPass(agentId, session));
			}
		});

		const commit = (w: Work, envelope: Envelope, actor: Actor) => {
			const outcome = w.do(envelope, actor);
			if (outcome.outcome !== 'rejected' && outcome.outcome !== 'noop') changed();
			return outcome;
		};
		const ready = (): Work => currentWork();

		return {
			read(input, context) {
				actorFor(context); // a signed-in person or a calling agent
				const w = ready();
				const i = input as any;
				switch (i.view) {
					case 'home':
						return w.views.home(w.owner, i.since ?? null);
					case 'project':
					case 'task':
					case 'job':
						return i.id
							? ((w.views as any)[i.view](i.id) ?? { error: 'not_found' })
							: { error: 'id_required' };
					case 'search':
						return { results: i.text ? w.views.search(i.text) : [] };
					case 'get':
						return i.id ? (w.views.get(i.id) ?? { error: 'not_found' }) : { error: 'id_required' };
					case 'needs_you':
						return w.views.needsYou();
					case 'help':
						return i.command
							? (w.help(i.command) ?? { error: 'unknown_command' })
							: { commands: w.catalog() };
				}
				return { error: 'unknown_view' };
			},
			do(input, context) {
				const w = ready();
				return commit(w, envelopeFor(input as any, context), actorFor(context));
			},
			plan(input, context) {
				const w = ready();
				const i = input as any;
				if (!!i.project === !!i.new_project)
					return invalid('Give project (an existing Project id) or new_project, not both');
				const plan = { milestones: i.milestones, tasks: i.tasks };
				const actor = actorFor(context);
				const r = commit(
					w,
					envelopeFor(
						i.project
							? { command: 'plan_project', id: i.project, input: plan }
							: { command: 'create_project', input: { ...i.new_project, ...plan } },
						context
					),
					actor
				);
				if (
					r.outcome !== 'rejected' &&
					'id' in r &&
					r.id &&
					context.source === 'tool' &&
					context.tool.sessionKey
				)
					w.linkSession(r.id, 'project', context.tool.sessionKey);
				return r;
			},
			task(input, context) {
				const w = ready();
				const actor = actorFor(context);
				const i = input as any;
				const session = context.source === 'tool' ? context.tool.sessionKey : undefined;
				const on = (command: string, body: Record<string, unknown>) =>
					commit(w, envelopeFor({ command, id: i.id, input: body }, context), actor);
				switch (i.action) {
					case 'create': {
						const fields: Record<string, unknown> = {};
						for (const k of [
							'title',
							'description',
							'done_when',
							'project',
							'milestone',
							'job',
							'depends_on',
							'plan'
						])
							if (i[k] !== undefined) fields[k] = i[k];
						const created = commit(
							w,
							envelopeFor({ command: 'create_task', input: fields }, context),
							actor
						);
						if (!('id' in created) || !created.id) return created;
						if (session) w.linkSession(created.id, 'task', session);
						if (!i.start) return created;
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
						if (r.outcome !== 'rejected' && session && i.id) w.linkSession(i.id, 'task', session);
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
			job(input, context) {
				const w = ready();
				const actor = actorFor(context);
				const i = input as any;
				const session = context.source === 'tool' ? context.tool.sessionKey : undefined;
				const on = (command: string, body: Record<string, unknown>) =>
					commit(w, envelopeFor({ command, id: i.id, input: body }, context), actor);
				switch (i.action) {
					case 'create': {
						const r = commit(
							w,
							envelopeFor(
								{
									command: 'create_job',
									input: {
										title: i.title,
										instructions: i.instructions,
										...(i.automations ? { automations: i.automations } : {})
									}
								},
								context
							),
							actor
						);
						if ('id' in r && r.id && session) w.linkSession(r.id, 'job', session);
						return r;
					}
					case 'edit':
						return on('edit_job', {
							...(i.title ? { title: i.title } : {}),
							...(i.instructions ? { instructions: i.instructions } : {}),
							...(i.reason ? { reason: i.reason } : {})
						});
					case 'pause':
					case 'resume':
					case 'retire':
						return on(`${i.action}_job`, i.reason ? { reason: i.reason } : {});
					case 'link_automation':
						if (!i.automation) return invalid('link_automation: give automation {id, name?}');
						return on('link_automation', i.automation);
					case 'unlink_automation':
						if (!i.automation) return invalid('unlink_automation: give automation {id}');
						return on('unlink_automation', { id: i.automation.id });
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
					if (w.kindOf(id) !== 'task') return invalid(`holds: ${id} is not a Task`);
				const to: string[] = i.to?.length ? i.to : [w.owner];
				const about = targets.list.length ? { targets: targets.list } : {};
				const session = context.source === 'tool' ? context.tool.sessionKey : undefined;
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
									...(session ? { session } : {}),
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
										...(session ? { session } : {}),
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
				for (const id of holds)
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
									resume_when: i.kind === 'question' ? 'Answered' : 'Decided'
								}
							},
							context,
							`:hold:${id}`
						),
						actor
					);
				return {
					outcome: 'committed',
					...(raised.length === 1 ? { id: raised[0].id } : {}),
					[i.kind === 'question' ? 'questions' : 'decision']:
						i.kind === 'question' ? raised.map((x) => x.id) : raised[0].id
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
