import {
	defineFeaturePlugin,
	type FeatureInvocationContext
} from 'openclaw/plugin-sdk/feature-plugin';
import { contract, KINDS } from './contract.js';
import { PLUGIN_ID } from './identity.js';
import type { Work } from './store/work.js';
import { currentWork, startWork } from './plugin/runtime.js';
import type { Actor, Envelope } from './store/types.js';
import type { Kind } from './store/engine.js';
import { classify } from './plugin/activity.js';
import { GUIDANCE, renderBrief } from './plugin/brief.js';
import { currentHuman } from './plugin/identity.js';

/** Per-run bookkeeping for the end-of-turn nudge (spec §10). */
type RunState = { untracked: number; recorded: boolean; nudged: boolean };

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
				state = { untracked: 0, recorded: false, nudged: false };
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
		api.on('before_prompt_build', (_event, ctx) => {
			const work = ctx.agentId ? maybe() : null;
			if (!work || !ctx.agentId) return { prependSystemContext: GUIDANCE };
			const agent = `agent:${ctx.agentId}`;
			const key = ctx.sessionKey ?? agent;
			const now = work.now();
			const brief = renderBrief(work.reads, agent, lastBrief.get(key) ?? null, now);
			lastBrief.set(key, now);
			return { prependSystemContext: GUIDANCE, prependContext: brief };
		});

		// What the agent actually did: attached to its in-progress Task, or kept as untracked.
		api.on('after_tool_call', (event, ctx) => {
			const work = ctx.agentId ? maybe() : null;
			if (!work || !ctx.agentId) return;
			const state = runState(event.runId ?? ctx.runId);
			if (
				event.toolName.startsWith('falcon_work') &&
				event.toolName !== 'falcon_work_read' &&
				!event.error
			) {
				if (state) state.recorded = true;
				return;
			}
			const e = event as typeof event & { toolKind?: string; toolInputKind?: string };
			const kind =
				e.toolKind ??
				ctx.toolKind ??
				(e.toolInputKind || ctx.toolInputKind ? 'code_mode_exec' : undefined);
			const c = classify(event.toolName, event.params ?? {}, event.error, kind);
			if (!c) return;
			const r = work.recordActivity({
				agent: `agent:${ctx.agentId}`,
				session: ctx.sessionKey ?? null,
				...c
			});
			if (!r.task && state) state.untracked++;
		});

		// A turn that changed things no Task explains gets one more pass to record them.
		api.on('before_agent_finalize', (event) => {
			const state = event.runId ? runs.get(event.runId) : undefined;
			if (!state || event.stopHookActive || state.nudged || state.recorded || state.untracked === 0)
				return;
			state.nudged = true;
			return {
				action: 'revise',
				reason: 'Untracked changes',
				retry: {
					instruction:
						'You changed things this turn that no Task in Falcon Work explains. Before you finish, put them under the Task they belong to (falcon_work_task: create with start, or start an existing one), or attach the activity to an existing Task (falcon_work attach_activity). Then finish your reply.',
					idempotencyKey: `${PLUGIN_ID}-nudge:${event.runId}`,
					maxAttempts: 1
				}
			};
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
						return w.views.feed({ filter: f.feed, area: f.area, limit: f.limit });
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
					case 'activity':
						return w.reads.activity({
							untracked: f.untracked,
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
					case 'start':
						return on('start', { claim: true });
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
