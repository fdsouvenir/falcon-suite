import { Type } from 'typebox';
import { defineCommand, type Context } from '../engine.js';
import { reject } from '../types.js';
import {
	Id,
	Title,
	Text,
	Short,
	Reason,
	Sources,
	Who,
	obj,
	opt,
	PlanMilestone,
	PlanTask
} from '../schemas.js';
import { addPlan } from './plan.js';

export const UNFINISHED = "('open','ready','in_progress','waiting')";

export const projectCommands = [
	defineCommand({
		name: 'create_project',
		summary:
			'Create a Project: a bounded outcome that takes several deliverables, optionally with its whole plan (Milestones with their Tasks and dependencies).',
		input: obj({
			title: Title,
			outcome: Text,
			agent: opt(Who),
			status_line: opt(Short),
			milestones: opt(Type.Array(PlanMilestone, { maxItems: 50 })),
			tasks: opt(Type.Array(PlanTask, { maxItems: 100 }))
		}),
		run(ctx, i) {
			const id = ctx.newId();
			ctx.insert('project', {
				id,
				title: i.title,
				outcome: i.outcome,
				agent: i.agent ?? (ctx.actor.kind === 'agent' ? ctx.actor.id : null),
				status_line: i.status_line ?? null,
				status_line_at: i.status_line ? ctx.now : null,
				created_at: ctx.now,
				updated_at: ctx.now,
				version: 1
			});
			for (const f of ['title', 'outcome', ...(i.status_line ? ['status_line'] : [])])
				ctx.markWritten(id, f);
			ctx.event('project', id, 1);
			const plan = addPlan(ctx, id, i.milestones, i.tasks);
			ctx.done(id, 1, plan.tasks.length || plan.milestones.length ? plan : undefined);
		}
	}),
	defineCommand({
		name: 'edit_project',
		on: 'project',
		summary: "Change a Project's title or outcome.",
		input: obj({ title: opt(Title), outcome: opt(Text), reason: opt(Reason) }),
		run(ctx, i, p) {
			const { reason, ...rest } = i;
			if (rest.title === undefined && rest.outcome === undefined)
				reject('nothing_to_change', 'Give a title or outcome');
			const { version, written } = ctx.writeFields('project', p!.id as string, rest, {
				updated_at: ctx.now
			});
			if (version === null) return ctx.nothing(p!.id as string, p!.version as number);
			ctx.event('project', p!.id as string, version, { ...written, reason });
			ctx.done(p!.id as string, version);
		}
	}),
	defineCommand({
		name: 'abandon_project',
		on: 'project',
		summary:
			'Abandon a Project, deciding for each unfinished Task whether to abandon it or detach it as a standalone Task.',
		input: obj({
			reason: Reason,
			dispositions: opt(
				Type.Record(Type.String(), Type.Union([Type.Literal('abandon'), Type.Literal('detach')]))
			)
		}),
		run(ctx, i, p) {
			const id = p!.id as string;
			if (p!.abandoned_at) return ctx.nothing(id, p!.version as number);
			const open = ctx.all<{ id: string; title: string }>(
				`SELECT t.id, d.title FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev
				 WHERE t.project_id = ? AND t.status IN ${UNFINISHED}`,
				id
			);
			const disp: Record<string, string> = i.dispositions ?? {};
			const missing = open.filter((t) => !disp[t.id]);
			if (missing.length)
				reject(
					'dispositions_required',
					'Choose abandon or detach for every unfinished Task; nothing was changed',
					missing.map((t) => `${t.id}: ${t.title}`)
				);
			for (const t of open) {
				if (disp[t.id] === 'abandon') {
					const v = ctx.update('task', t.id, {
						status: 'abandoned',
						prior_status: null,
						updated_at: ctx.now
					});
					ctx.event('task', t.id, v, { reason: `Project abandoned: ${i.reason}` });
				} else {
					const v = ctx.update('task', t.id, {
						project_id: null,
						milestone_id: null,
						updated_at: ctx.now
					});
					ctx.event('task', t.id, v, { detached_from: id });
				}
			}
			const v = ctx.update('project', id, { abandoned_at: ctx.now });
			ctx.event('project', id, v, { reason: i.reason });
			ctx.done(id, v);
		}
	}),
	defineCommand({
		name: 'resume_project',
		on: 'project',
		summary: 'Resume an abandoned Project.',
		input: obj({ reason: Reason }),
		run(ctx, i, p) {
			if (!p!.abandoned_at) return ctx.nothing(p!.id as string, p!.version as number);
			const v = ctx.update('project', p!.id as string, { abandoned_at: null });
			ctx.event('project', p!.id as string, v, { reason: i.reason });
			ctx.done(p!.id as string, v);
		}
	}),

	defineCommand({
		name: 'add_milestone',
		on: 'project',
		summary: 'Add a Milestone to a Project, at the end or at a position.',
		input: obj({
			title: Title,
			success_condition: Text,
			position: opt(Type.Integer({ minimum: 1 }))
		}),
		run(ctx, i, p) {
			const count = ctx.one<{ n: number }>(
				'SELECT count(*) AS n FROM milestone WHERE project_id = ?',
				p!.id as string
			)!.n;
			const position = Math.min(i.position ?? count + 1, count + 1);
			ctx.run(
				'UPDATE milestone SET position = position + 1 WHERE project_id = ? AND position >= ?',
				p!.id as string,
				position
			);
			const id = ctx.newId();
			ctx.insert('milestone', {
				id,
				project_id: p!.id,
				title: i.title,
				success_condition: i.success_condition,
				position,
				status: 'open',
				version: 1
			});
			ctx.event('milestone', id, 1, { project: p!.id, position });
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'plan_project',
		on: 'project',
		summary:
			'Add a plan to a Project in one step: new Milestones with their Tasks, and Tasks for existing Milestones. Tasks name each other by key in depends_on.',
		input: obj({
			milestones: opt(Type.Array(PlanMilestone, { maxItems: 50 })),
			tasks: opt(Type.Array(obj({ ...PlanTask.properties, milestone: opt(Id) }), { maxItems: 100 }))
		}),
		run(ctx, i, p) {
			if (!i.milestones?.length && !i.tasks?.length)
				reject('empty_plan', 'Give at least one Milestone or Task');
			const plan = addPlan(ctx, p!.id as string, i.milestones, i.tasks);
			const v = ctx.update('project', p!.id as string, {});
			ctx.event('project', p!.id as string, v, {
				planned: { milestones: plan.milestones.length, tasks: plan.tasks.length }
			});
			ctx.done(p!.id as string, v, plan);
		}
	}),
	defineCommand({
		name: 'edit_milestone',
		on: 'milestone',
		summary: "Change a Milestone's title or success condition.",
		input: obj({ title: opt(Title), success_condition: opt(Text) }),
		run(ctx, i, m) {
			const fields = Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
			if (!Object.keys(fields).length)
				reject('nothing_to_change', 'Give a title or success condition');
			const v = ctx.update('milestone', m!.id as string, fields);
			ctx.event('milestone', m!.id as string, v, fields);
			ctx.done(m!.id as string, v);
		}
	}),
	defineCommand({
		name: 'reorder_milestones',
		on: 'project',
		summary: "Set the order of a Project's Milestones.",
		input: obj({ order: Type.Array(Id, { minItems: 1, maxItems: 50 }) }),
		run(ctx, i, p) {
			const ids = ctx
				.all<{ id: string }>('SELECT id FROM milestone WHERE project_id = ?', p!.id as string)
				.map((r) => r.id);
			const order: string[] = i.order;
			if (
				new Set(order).size !== order.length ||
				order.length !== ids.length ||
				!order.every((x) => ids.includes(x))
			)
				reject('incomplete_order', "List every one of the Project's Milestones exactly once");
			order.forEach((id, n) => ctx.update('milestone', id, { position: n + 1 }));
			const v = ctx.update('project', p!.id as string, {});
			ctx.event('project', p!.id as string, v, { milestones: order });
			ctx.done(p!.id as string, v);
		}
	}),
	defineCommand({
		name: 'achieve_milestone',
		on: 'milestone',
		summary:
			'Mark a Milestone achieved, with why and evidence. Refused while its Tasks are unfinished.',
		input: obj({ basis: Text, sources: Sources }),
		run(ctx, i, m) {
			const id = m!.id as string;
			if (m!.status === 'achieved') return ctx.nothing(id, m!.version as number);
			const open = ctx.all<{ id: string; title: string }>(
				`SELECT t.id, d.title FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev
				 WHERE t.milestone_id = ? AND t.status IN ${UNFINISHED}`,
				id
			);
			if (open.length)
				reject(
					'milestone_has_open_work',
					`${open.length} Task(s) still open: ${open.map((t) => `"${t.title}"`).join(', ')}`,
					['complete', 'abandon', 'detach_from_milestone']
				);
			const v = ctx.update('milestone', id, {
				status: 'achieved',
				achieved_at: ctx.now,
				basis: i.basis,
				sources: i.sources
			});
			ctx.event('milestone', id, v, { basis: i.basis });
			ctx.done(id, v);
		}
	}),
	defineCommand({
		name: 'reopen_milestone',
		on: 'milestone',
		summary: 'Reopen an achieved Milestone (which reopens a completed Project).',
		input: obj({ reason: Reason }),
		run(ctx, i, m) {
			if (m!.status === 'open') return ctx.nothing(m!.id as string, m!.version as number);
			const v = ctx.update('milestone', m!.id as string, {
				status: 'open',
				achieved_at: null,
				basis: null,
				sources: null
			});
			ctx.event('milestone', m!.id as string, v, { reason: i.reason });
			ctx.done(m!.id as string, v);
		}
	})
];
