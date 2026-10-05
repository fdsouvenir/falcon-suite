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
			if (event.toolName === 'falcon_work' && !event.error) {
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
						'You changed things this turn that no Task explains. Record them in Falcon Work now: start or create the Task they belong to (falcon_work), or attach the untracked activity to an existing Task. Then finish your reply.',
					idempotencyKey: `${PLUGIN_ID}-nudge:${event.runId}`,
					maxAttempts: 1
				}
			};
		});

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
				const envelope: Envelope = {
					...input,
					idempotency_key:
						input.idempotency_key ??
						(context.source === 'tool' ? `tool:${context.toolCallId}` : undefined)
				};
				const outcome = w.do(envelope, actorFor(context));
				if (outcome.outcome !== 'rejected' && outcome.outcome !== 'noop')
					// Best effort: the change is already committed; a failed notice must not make it look failed.
					try {
						events.emit('changed', { at: w.now() });
					} catch (error) {
						api.logger?.warn?.(`Falcon Work change notice failed: ${(error as Error).message}`);
					}
				return outcome;
			}
		};
	}
});

export default feature;
