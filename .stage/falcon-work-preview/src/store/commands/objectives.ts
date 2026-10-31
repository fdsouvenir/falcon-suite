import { Type } from 'typebox';
import { defineCommand, type Context } from '../engine.js';
import { reject } from '../types.js';
import {
	Id,
	Title,
	Text,
	Reason,
	When,
	Session,
	Sources,
	Short,
	obj,
	opt,
	Empty
} from '../schemas.js';

type ObjectiveRow = {
	id: string;
	status: string;
	rank: number | null;
	autonomy: string;
	owner: string;
	version: number;
};

const Autonomy = Type.Union([Type.Literal('propose'), Type.Literal('act')]);
const nextRank = (ctx: Context) =>
	(ctx.one<{ r: number | null }>('SELECT max(rank) AS r FROM objective')?.r ?? 0) + 1;

/** Moving an Objective out of `active` frees its rank and closes the gap. */
function leaveActive(ctx: Context, o: ObjectiveRow, status: string, reason?: string) {
	if (o.status === status) return ctx.nothing(o.id, o.version);
	const fields: Record<string, unknown> = { status };
	if (o.status === 'active') fields.rank = null;
	if (status === 'active') fields.rank = nextRank(ctx);
	const v = ctx.update('objective', o.id, fields);
	if (o.status === 'active' && o.rank !== null) {
		// Two steps keep the unique rank index satisfied while closing the gap.
		ctx.run('UPDATE objective SET rank = -rank WHERE rank > ?', o.rank);
		ctx.run('UPDATE objective SET rank = -rank - 1 WHERE rank < 0');
	}
	ctx.event('objective', o.id, v, { status, ...(reason ? { reason } : {}) });
	ctx.done(o.id, v);
}

export const objectiveCommands = [
	defineCommand({
		name: 'create_objective',
		humanOnly: true,
		summary: 'Create an active Objective, ranked last unless a rank is given.',
		input: obj({
			title: Title,
			statement: Text,
			autonomy: opt(Autonomy),
			limits: opt(Short),
			session: opt(Session)
		}),
		run(ctx, i) {
			if (i.autonomy === 'act' && !i.limits)
				reject('limits_required', 'Autonomy "act" needs written limits');
			const id = ctx.newId();
			ctx.insert('objective', {
				id,
				title: i.title,
				statement: i.statement,
				rank: nextRank(ctx),
				status: 'active',
				autonomy: i.autonomy ?? 'propose',
				limits: i.limits ?? null,
				owner: ctx.actor.id,
				session_key: i.session ?? null,
				session_set_by: i.session ? ctx.actor.id : null,
				created_at: ctx.now,
				version: 1
			});
			ctx.event('objective', id, 1);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'edit_objective',
		on: 'objective',
		humanOnly: true,
		summary: "Change an Objective's title or statement.",
		input: obj({ title: opt(Title), statement: opt(Text) }),
		run(ctx, i, o) {
			const fields = Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
			if (!Object.keys(fields).length) reject('nothing_to_change', 'Give a title or statement');
			const v = ctx.update('objective', o!.id as string, fields);
			ctx.event('objective', o!.id as string, v, fields);
			ctx.done(o!.id as string, v);
		}
	}),
	defineCommand({
		name: 'rank_objectives',
		humanOnly: true,
		summary: 'Set the order of all active Objectives.',
		input: obj({ order: Type.Array(Id, { minItems: 1, maxItems: 100 }) }),
		run(ctx, i) {
			const active = ctx
				.all<{ id: string }>("SELECT id FROM objective WHERE status = 'active'")
				.map((r) => r.id);
			const order: string[] = i.order;
			if (
				new Set(order).size !== order.length ||
				order.length !== active.length ||
				!order.every((id) => active.includes(id))
			)
				reject('incomplete_ranking', 'List every active Objective exactly once', [
					'read objectives'
				]);
			ctx.run("UPDATE objective SET rank = -rank WHERE status = 'active'");
			order.forEach((id, n) => {
				const v = ctx.update('objective', id, { rank: n + 1 });
				ctx.event('objective', id, v, { rank: n + 1 });
			});
			ctx.done(order[0], null);
		}
	}),
	defineCommand({
		name: 'set_autonomy',
		on: 'objective',
		humanOnly: true,
		summary: 'Choose whether agents propose or act toward an Objective.',
		input: obj({ autonomy: Autonomy, limits: opt(Short) }),
		run(ctx, i, o) {
			if (i.autonomy === 'act' && !i.limits)
				reject('limits_required', 'Autonomy "act" needs written limits');
			const v = ctx.update('objective', o!.id as string, {
				autonomy: i.autonomy,
				limits: i.autonomy === 'act' ? i.limits : null
			});
			ctx.event('objective', o!.id as string, v, i);
			ctx.done(o!.id as string, v);
		}
	}),
	...(['pause', 'resume', 'achieve', 'retire'] as const).map((verb) =>
		defineCommand({
			name: `${verb}_objective`,
			on: 'objective',
			humanOnly: true,
			summary: `${verb[0].toUpperCase()}${verb.slice(1)} an Objective.`,
			input: obj({ reason: opt(Reason) }),
			run(ctx, i, o) {
				const status = {
					pause: 'paused',
					resume: 'active',
					achieve: 'achieved',
					retire: 'retired'
				}[verb];
				leaveActive(ctx, o as unknown as ObjectiveRow, status, i.reason);
			}
		})
	),
	defineCommand({
		name: 'add_kpi',
		on: 'objective',
		humanOnly: true,
		summary: 'Add a KPI to an Objective.',
		input: obj({
			name: Title,
			unit: Type.String({ minLength: 1, maxLength: 40 }),
			direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('hold')]),
			target: Type.Number(),
			target_date: opt(When)
		}),
		run(ctx, i, o) {
			const id = ctx.newId();
			ctx.insert('kpi', {
				id,
				objective_id: o!.id,
				...i,
				target_date: i.target_date ?? null,
				version: 1
			});
			ctx.event('kpi', id, 1, { objective: o!.id });
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'edit_kpi',
		on: 'kpi',
		humanOnly: true,
		summary: "Change a KPI's name, unit, direction or target.",
		input: obj({
			name: opt(Title),
			unit: opt(Type.String({ minLength: 1, maxLength: 40 })),
			direction: opt(Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('hold')])),
			target: opt(Type.Number()),
			target_date: opt(When)
		}),
		run(ctx, i, k) {
			const fields = Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
			const v = ctx.update('kpi', k!.id as string, fields);
			ctx.event('kpi', k!.id as string, v, fields);
			ctx.done(k!.id as string, v);
		}
	}),
	defineCommand({
		name: 'remove_kpi',
		on: 'kpi',
		humanOnly: true,
		summary: 'Remove a KPI; its readings stay in history.',
		input: Empty,
		run(ctx, _i, k) {
			if (k!.removed_at) return ctx.nothing(k!.id as string, k!.version as number);
			const v = ctx.update('kpi', k!.id as string, { removed_at: ctx.now });
			ctx.event('kpi', k!.id as string, v);
			ctx.done(k!.id as string, v);
		}
	}),
	defineCommand({
		name: 'record_kpi_reading',
		on: 'kpi',
		summary: 'Record a KPI reading with its source.',
		input: obj({
			value: Type.Number(),
			at: opt(When),
			source: Type.String({ minLength: 1, maxLength: 1000 })
		}),
		run(ctx, i, k) {
			if (k!.removed_at) reject('kpi_removed', 'This KPI was removed');
			const id = ctx.newId();
			ctx.insert('kpi_reading', {
				id,
				kpi_id: k!.id,
				value: i.value,
				at: i.at ?? ctx.now,
				source: i.source,
				recorded_by: ctx.actor.id
			});
			ctx.event('kpi', k!.id as string, null, { reading: id, value: i.value });
			ctx.done(id, null);
		}
	}),
	defineCommand({
		name: 'write_review',
		on: 'objective',
		summary: 'Write an immutable review of an Objective; proposals become Decisions for its owner.',
		input: obj({
			moved: Text,
			stalled: Text,
			proposed: opt(Text),
			sources: Sources
		}),
		run(ctx, i, o) {
			if (ctx.actor.kind !== 'agent') reject('agent_only', 'Reviews are written by the agent');
			if (o!.status !== 'active') reject('not_active', 'Only active Objectives are reviewed');
			const id = ctx.newId();
			ctx.insert('review', {
				id,
				objective_id: o!.id,
				author: ctx.actor.id,
				at: ctx.now,
				moved: i.moved,
				stalled: i.stalled,
				proposed: i.proposed ?? null,
				sources: i.sources
			});
			ctx.event('objective', o!.id as string, null, { review: id });
			ctx.done(id, null);
		}
	})
];
