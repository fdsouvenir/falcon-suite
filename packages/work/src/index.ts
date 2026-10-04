import path from 'node:path';
import {
	defineFeaturePlugin,
	type FeatureInvocationContext
} from 'openclaw/plugin-sdk/feature-plugin';
import { contract, KINDS } from './contract.js';
import { Work } from './store/work.js';
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
	if (!human) throw new Error('Falcon Work needs a signed-in person');
	return human;
}

const feature = defineFeaturePlugin({
	contract,
	name: 'Falcon Work',
	description: 'A record of what your agents do, why, and what needs you.',
	setup(api, events) {
		let work: Work | null = null;
		const runs = new Map<string, RunState>();
		const lastBrief = new Map<string, string>();

		const ready = (): Work => {
			if (!work) throw new Error('Falcon Work is starting; try again in a moment');
			return work;
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
			id: 'falcon-work',
			async start(ctx) {
				// Feature plugins take no config in this SDK, so the location and owner are fixed.
				work = new Work(path.join(ctx.stateDir, 'falcon-work', 'work.db'), 'person:gateway-owner');
			},
			async stop() {
				work?.close();
				work = null;
			}
		});

		// The guidance (static, so it caches) and the agent's brief, every turn (spec §10).
		api.on('before_prompt_build', (_event, ctx) => {
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
			if (!work || !ctx.agentId) return;
			const state = runState(event.runId ?? ctx.runId);
			if (event.toolName === 'falcon_work' && !event.error) {
				if (state) state.recorded = true;
				return;
			}
			const c = classify(event.toolName, event.params ?? {}, event.error);
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
					idempotencyKey: `falcon-work-nudge:${event.runId}`,
					maxAttempts: 1
				}
			};
		});

		return {
			read(input, context) {
				const w = ready();
				const f = input.filters ?? {};
				switch (input.view) {
					case 'brief': {
						const actor = actorFor(context);
						return actor.kind === 'agent'
							? w.reads.brief(actor.id, null, w.now())
							: w.reads.needsYou(actor.id, w.now());
					}
					case 'needs_you':
						return w.reads.needsYou(actorFor(context).id, w.now());
					case 'objectives':
						return w.reads.objectives(!!f.include_inactive);
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
					events.emit('changed', { at: w.now() });
				return outcome;
			}
		};
	}
});

export default feature;
