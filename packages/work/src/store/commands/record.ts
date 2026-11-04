import { Type } from 'typebox';
import { defineCommand, type Context } from '../engine.js';
import { reject } from '../types.js';
import { Id, Short, Text, obj, opt } from '../schemas.js';

const ItemKind = Type.Union([Type.Literal('task'), Type.Literal('project'), Type.Literal('job')]);

/** The kind of a Job, Project or Task by id, or reject. */
export function itemKind(ctx: Context, id: string): 'task' | 'project' | 'job' {
	for (const k of ['task', 'project', 'job'] as const)
		if (ctx.one(`SELECT 1 FROM ${k} WHERE id = ?`, id)) return k;
	return reject('not_found', `No Job, Project or Task ${id}`);
}

/** Commands about the record itself: status lines and where the work happened (spec §3, §4). */
export const recordCommands = [
	defineCommand({
		name: 'set_status_line',
		summary: 'Say in one plain sentence where a Job, Project or Task stands now.',
		input: obj({ item: Id, status_line: Short }),
		run(ctx, i) {
			const kind = itemKind(ctx, i.item);
			const { version } = ctx.writeFields(
				kind,
				i.item,
				{ status_line: i.status_line },
				{ status_line_at: ctx.now, updated_at: ctx.now }
			);
			if (version === null) {
				const cur = ctx.one<{ version: number }>(
					`SELECT version FROM ${kind} WHERE id = ?`,
					i.item
				)!;
				return ctx.nothing(i.item, cur.version);
			}
			ctx.event(kind, i.item, version, { status_line: i.status_line });
			ctx.done(i.item, version);
		}
	}),
	defineCommand({
		name: 'attach_task',
		on: 'task',
		summary:
			'Put a Task under a Project (optionally a Milestone) or a Job, or make it standalone by giving neither.',
		input: obj({ project: opt(Id), milestone: opt(Id), job: opt(Id), reason: opt(Text) }),
		run(ctx, i, t) {
			if (i.project && i.job) reject('placement', 'A Task belongs to a Project or a Job, not both');
			if (i.milestone && !i.project) reject('placement', 'A Milestone needs its Project');
			if (i.project) {
				const p = ctx.get<{ abandoned_at: string | null }>('project', i.project);
				if (p.abandoned_at)
					reject('project_abandoned', 'That Project is abandoned', ['resume_project']);
			}
			if (i.milestone) {
				const m = ctx.get<{ project_id: string; status: string }>('milestone', i.milestone);
				if (m.project_id !== i.project)
					reject('placement', 'That Milestone belongs to another Project');
				if (m.status === 'achieved')
					reject('milestone_achieved', 'That Milestone is achieved', ['reopen_milestone']);
			}
			if (i.job) {
				const j = ctx.get<{ status: string }>('job', i.job);
				if (j.status === 'retired') reject('job_retired', 'That Job is retired');
			}
			const where = {
				project_id: i.project ?? null,
				milestone_id: i.milestone ?? null,
				job_id: i.job ?? null
			};
			if (
				t!.project_id === where.project_id &&
				t!.milestone_id === where.milestone_id &&
				t!.job_id === where.job_id
			)
				return ctx.nothing(t!.id as string, t!.version as number);
			const v = ctx.update('task', t!.id as string, { ...where, updated_at: ctx.now });
			ctx.event('task', t!.id as string, v, {
				from: { project: t!.project_id, milestone: t!.milestone_id, job: t!.job_id },
				to: where,
				reason: i.reason
			});
			ctx.done(t!.id as string, v);
		}
	}),
	defineCommand({
		name: 'promote_to_project',
		on: 'task',
		summary:
			'Turn a Task that grew a second deliverable into a Project. The Task stays, as the first Task of the new Project, with its history.',
		input: obj({ title: opt(Short), outcome: Text }),
		run(ctx, i, t) {
			if (t!.project_id) reject('already_in_project', 'The Task is already part of a Project');
			const def = ctx.one<{ title: string }>(
				'SELECT title FROM task_definition WHERE task_id = ? AND rev = ?',
				t!.id as string,
				t!.definition_rev as number
			)!;
			const project = ctx.newId();
			ctx.insert('project', {
				id: project,
				title: i.title ?? def.title,
				outcome: i.outcome,
				agent: t!.agent ?? null,
				status_line: t!.status_line ?? null,
				status_line_at: t!.status_line_at ?? null,
				created_at: ctx.now,
				updated_at: ctx.now,
				version: 1
			});
			for (const f of ['title', 'outcome']) ctx.markWritten(project, f);
			ctx.event('project', project, 1, { promoted_from: t!.id });
			for (const s of ctx.all<{ session_key: string; first_seen_at: string; last_seen_at: string }>(
				'SELECT session_key, first_seen_at, last_seen_at FROM item_session WHERE item_id = ?',
				t!.id as string
			))
				ctx.run(
					'INSERT OR IGNORE INTO item_session (item_id, item_kind, session_key, first_seen_at, last_seen_at) VALUES (?,?,?,?,?)',
					project,
					'project',
					s.session_key,
					s.first_seen_at,
					s.last_seen_at
				);
			const v = ctx.update('task', t!.id as string, {
				project_id: project,
				job_id: null,
				updated_at: ctx.now
			});
			ctx.event('task', t!.id as string, v, { promoted_to: project });
			ctx.done(project, 1, { project, task: t!.id });
		}
	}),
	defineCommand({
		name: 'record_entry',
		summary:
			'Add a line to the history of a Job, Project or Task: one sentence on what happened, with what it left outside the chat.',
		input: obj({
			item: Id,
			summary: Short,
			session: opt(Short),
			outcomes: opt(
				Type.Array(
					obj({
						kind: Type.String({ minLength: 1, maxLength: 20 }),
						label: Short,
						ref: opt(Short)
					}),
					{ maxItems: 50 }
				)
			)
		}),
		run(ctx, i) {
			const kind = itemKind(ctx, i.item);
			const id = ctx.newId();
			ctx.insert('timeline_entry', {
				id,
				subject_kind: kind,
				subject_id: i.item,
				agent: ctx.actor.id,
				session_key: i.session ?? null,
				run_id: null,
				at: ctx.now,
				outcomes: i.outcomes ?? [],
				summary: i.summary,
				recorded_by: ctx.by
			});
			ctx.event('timeline_entry', id, null, { item: i.item });
			ctx.done(id, null);
		}
	})
];

export { ItemKind };
