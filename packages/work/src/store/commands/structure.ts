import { Type } from 'typebox';
import { defineCommand, type Context } from '../engine.js';
import { InputRequired, reject } from '../types.js';
import { Id, Title, Text, Reason, Session, Sources, Who, obj, opt } from '../schemas.js';

const UNFINISHED = "('open','ready','in_progress','waiting')";

/**
 * An agent creating Work that serves a *propose* Objective needs a decided Decision targeting that
 * Objective (spec §3, commands §10). Humans and *act* Objectives need nothing.
 */
export function checkServes(
	ctx: Context,
	objectives: string[] | undefined,
	decision: string | undefined
) {
	for (const id of objectives ?? []) {
		const o = ctx.get<{ id: string; status: string; autonomy: string; owner: string }>(
			'objective',
			id
		);
		if (o.status !== 'active') reject('objective_not_active', `Objective ${id} is not active`);
		if (ctx.actor.kind === 'human' || o.autonomy === 'act') continue;
		const approved =
			decision &&
			ctx.one(
				"SELECT 1 FROM decision d JOIN link l ON l.kind = 'targets' AND l.source_id = d.id AND l.target_id = ? WHERE d.id = ? AND d.status = 'decided'",
				id,
				decision
			);
		if (!approved)
			reject(
				'proposal_required',
				`Objective "${id}" is set to propose: raise a Decision for its owner first, then pass the decided Decision as "decision"`,
				['raise_decision']
			);
	}
}

export const structureCommands = [
	defineCommand({
		name: 'create_area',
		summary: 'Create an Area: a standing responsibility.',
		input: obj({ title: Title, description: Text, accountable_human: opt(Who) }),
		run(ctx, i) {
			const id = ctx.newId();
			const accountable =
				i.accountable_human ?? (ctx.actor.kind === 'human' ? ctx.actor.id : ctx.owner);
			ctx.insert('area', {
				id,
				title: i.title,
				description: i.description,
				status: 'active',
				accountable_human: accountable,
				created_at: ctx.now,
				version: 1
			});
			ctx.event('area', id, 1);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'edit_area',
		on: 'area',
		summary: "Change an Area's title, description or accountable person.",
		input: obj({ title: opt(Title), description: opt(Text), accountable_human: opt(Who) }),
		run(ctx, i, a) {
			const fields = Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
			if (!Object.keys(fields).length) reject('nothing_to_change', 'Give something to change');
			const v = ctx.update('area', a!.id as string, fields);
			ctx.event('area', a!.id as string, v, fields);
			ctx.done(a!.id as string, v);
		}
	}),
	defineCommand({
		name: 'retire_area',
		on: 'area',
		humanOnly: true,
		summary: 'Retire an Area that holds no unfinished Work.',
		input: obj({ reason: Reason }),
		run(ctx, i, a) {
			const busy = ctx.one<{ n: number }>(
				`SELECT count(*) AS n FROM task t LEFT JOIN project p ON p.id = t.project_id
				 WHERE (t.area_id = ? OR p.area_id = ?) AND t.status IN ${UNFINISHED}`,
				a!.id as string,
				a!.id as string
			)!.n;
			if (busy)
				reject('area_has_work', `${busy} unfinished Task(s) still in this Area`, [
					'move_task',
					'abandon'
				]);
			const v = ctx.update('area', a!.id as string, { status: 'retired' });
			ctx.event('area', a!.id as string, v, { reason: i.reason });
			ctx.done(a!.id as string, v);
		}
	}),

	defineCommand({
		name: 'create_project',
		summary:
			'Create a Project in an Area, optionally with Milestones and the Objectives it serves.',
		input: obj({
			title: Title,
			outcome: Text,
			area: Id,
			serves: opt(Type.Array(Id, { maxItems: 20 })),
			decision: opt(Id),
			milestones: opt(Type.Array(obj({ title: Title, success_condition: Text }), { maxItems: 50 })),
			session: opt(Session)
		}),
		run(ctx, i) {
			const area = ctx.get<{ id: string; status: string; accountable_human: string }>(
				'area',
				i.area
			);
			if (area.status !== 'active') reject('area_retired', 'That Area is retired');
			checkServes(ctx, i.serves, i.decision);
			const id = ctx.newId();
			ctx.insert('project', {
				id,
				title: i.title,
				outcome: i.outcome,
				area_id: area.id,
				accountable_human: area.accountable_human,
				session_key: i.session ?? null,
				session_set_by: i.session ? ctx.actor.id : null,
				created_at: ctx.now,
				version: 1
			});
			for (const o of i.serves ?? []) ctx.link('serves', 'project', id, 'objective', o);
			(i.milestones ?? []).forEach((m: { title: string; success_condition: string }, n: number) =>
				ctx.insert('milestone', {
					id: ctx.newId(),
					project_id: id,
					title: m.title,
					success_condition: m.success_condition,
					position: n + 1,
					status: 'open',
					version: 1
				})
			);
			ctx.event('project', id, 1, i.decision ? { decision: i.decision } : undefined);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'edit_project',
		on: 'project',
		summary: "Change a Project's title or outcome.",
		input: obj({ title: opt(Title), outcome: opt(Text), reason: Reason }),
		run(ctx, i, p) {
			const { reason, ...rest } = i;
			const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
			if (!Object.keys(fields).length) reject('nothing_to_change', 'Give a title or outcome');
			const v = ctx.update('project', p!.id as string, fields);
			ctx.event('project', p!.id as string, v, { ...fields, reason });
			ctx.done(p!.id as string, v);
		}
	}),
	defineCommand({
		name: 'move_project',
		on: 'project',
		summary: 'Move a Project to another Area.',
		input: obj({ area: Id, reason: Reason }),
		run(ctx, i, p) {
			const area = ctx.get<{ id: string; status: string }>('area', i.area);
			if (area.status !== 'active') reject('area_retired', 'That Area is retired');
			if (p!.area_id === area.id) return ctx.nothing(p!.id as string, p!.version as number);
			const v = ctx.update('project', p!.id as string, { area_id: area.id });
			ctx.event('project', p!.id as string, v, { from: p!.area_id, to: area.id, reason: i.reason });
			ctx.done(p!.id as string, v);
		}
	}),
	defineCommand({
		name: 'abandon_project',
		on: 'project',
		summary:
			'Abandon a Project, deciding for each unfinished Task whether to abandon it or detach it into the Area.',
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
			if (missing.length) {
				// Nothing is applied: each undecided Task gets an Ask to whoever is accountable.
				const to = p!.accountable_human as string;
				throw new InputRequired(
					missing.map((t) => ({
						from: to,
						what: `Abandon or detach "${t.title}" (${t.id})`,
						ask: ctx.ask(
							'task',
							t.id,
							to,
							`Project is being abandoned: abandon "${t.title}" too, or detach it into the Area?`,
							(p!.session_key as string) ?? null
						)
					})),
					id
				);
			}
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
						area_id: p!.area_id,
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
	}),
	defineCommand({
		name: 'serve',
		summary: 'Link a Project or Task to an Objective it serves.',
		input: obj({
			kind: Type.Union([Type.Literal('project'), Type.Literal('task')]),
			id: Id,
			objective: Id,
			decision: opt(Id)
		}),
		run(ctx, i) {
			const row = ctx.get(i.kind, i.id);
			checkServes(ctx, [i.objective], i.decision);
			ctx.link('serves', i.kind, i.id, 'objective', i.objective);
			const v = ctx.update(i.kind, i.id, {});
			ctx.event(i.kind, i.id, v, { serves: i.objective });
			ctx.done(row.id as string, v);
		}
	}),
	defineCommand({
		name: 'unserve',
		summary: 'Remove a link from a Project or Task to an Objective.',
		input: obj({
			kind: Type.Union([Type.Literal('project'), Type.Literal('task')]),
			id: Id,
			objective: Id
		}),
		run(ctx, i) {
			ctx.get(i.kind, i.id);
			ctx.run(
				"DELETE FROM link WHERE kind = 'serves' AND source_id = ? AND target_id = ?",
				i.id,
				i.objective
			);
			const v = ctx.update(i.kind, i.id, {});
			ctx.event(i.kind, i.id, v, { unserves: i.objective });
			ctx.done(i.id, v);
		}
	}),
	defineCommand({
		name: 'set_session',
		summary:
			"Set or clear the discussion session of an Objective, Project, Task or Ask. A person's choice can only be changed by a person.",
		input: obj({
			kind: Type.Union([
				Type.Literal('objective'),
				Type.Literal('project'),
				Type.Literal('task'),
				Type.Literal('ask')
			]),
			id: Id,
			session: Type.Union([Session, Type.Null()])
		}),
		run(ctx, i) {
			const row = ctx.get(i.kind, i.id);
			if (row.session_key === i.session) return ctx.nothing(i.id, row.version as number);
			if (
				ctx.actor.kind === 'agent' &&
				typeof row.session_set_by === 'string' &&
				row.session_set_by.startsWith('person:')
			)
				reject('human_choice', 'A person chose this session; only a person can change it');
			const v = ctx.update(i.kind, i.id, {
				session_key: i.session,
				session_set_by: i.session ? ctx.actor.id : null
			});
			ctx.event(i.kind, i.id, v, { session: i.session });
			ctx.done(i.id, v);
		}
	})
];
