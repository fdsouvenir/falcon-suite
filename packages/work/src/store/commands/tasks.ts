import { Type } from 'typebox';
import { defineCommand, type Context } from '../engine.js';
import { InputRequired, reject } from '../types.js';
import {
	Id,
	Title,
	Text,
	Reason,
	When,
	Who,
	Session,
	Sources,
	obj,
	opt,
	Empty
} from '../schemas.js';
import { checkServes } from './structure.js';

type TaskRow = {
	id: string;
	status: string;
	prior_status: string | null;
	agent: string | null;
	area_id: string | null;
	project_id: string | null;
	milestone_id: string | null;
	definition_rev: number;
	session_key: string | null;
	version: number;
};
const FINISHED = ['completed', 'abandoned'];

/** Resolve placement: exactly one of area / project; a milestone must belong to the project. */
function placement(ctx: Context, i: { area?: string; project?: string; milestone?: string }) {
	if (!!i.area === !!i.project)
		reject('placement', 'Place the Task in exactly one Area or Project');
	if (i.area) {
		const a = ctx.get<{ status: string }>('area', i.area);
		if (a.status !== 'active') reject('area_retired', 'That Area is retired');
		if (i.milestone) reject('placement', 'A Milestone needs a Project');
		return { area_id: i.area, project_id: null, milestone_id: null };
	}
	const p = ctx.get<{ abandoned_at: string | null }>('project', i.project);
	if (p.abandoned_at) reject('project_abandoned', 'That Project is abandoned', ['resume_project']);
	if (i.milestone) {
		const m = ctx.get<{ project_id: string; status: string }>('milestone', i.milestone);
		if (m.project_id !== i.project)
			reject('placement', 'That Milestone belongs to another Project');
		if (m.status === 'achieved')
			reject('milestone_achieved', 'That Milestone is achieved', ['reopen_milestone']);
	}
	return { area_id: null, project_id: i.project!, milestone_id: i.milestone ?? null };
}

function setStatus(
	ctx: Context,
	t: TaskRow,
	status: string,
	extra: Record<string, unknown> = {},
	detail?: unknown
) {
	const v = ctx.update('task', t.id, { status, updated_at: ctx.now, ...extra });
	ctx.event('task', t.id, v, { from: t.status, to: status, ...(detail as object) });
	ctx.done(t.id, v);
}

function warnDependencies(ctx: Context, t: TaskRow) {
	for (const d of ctx.all<{ id: string; title: string }>(
		`SELECT t.id, d.title FROM link l JOIN task t ON t.id = l.target_id
		 JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev
		 WHERE l.kind = 'depends_on' AND l.source_id = ? AND t.status NOT IN ('completed','abandoned')`,
		t.id
	))
		ctx.warn('dependency_unfinished', `Depends on "${d.title}", which is not finished`, d.id);
}

export function insertTask(
	ctx: Context,
	i: any,
	where: { area_id: string | null; project_id: string | null; milestone_id: string | null }
) {
	checkServes(ctx, i.serves, i.decision);
	if (i.agent && !i.agent.startsWith('agent:'))
		reject('not_an_agent', 'Tasks are assigned to agents');
	const id = ctx.newId();
	ctx.insert('task', {
		id,
		...where,
		status: 'open',
		agent: i.agent ?? null,
		definition_rev: 1,
		session_key: i.session ?? null,
		session_set_by: i.session ? ctx.actor.id : null,
		created_at: ctx.now,
		updated_at: ctx.now,
		version: 1
	});
	ctx.insert('task_definition', {
		task_id: id,
		rev: 1,
		title: i.title,
		description: i.description,
		done_when: i.done_when,
		author: ctx.actor.id,
		at: ctx.now
	});
	if (i.plan)
		ctx.insert('task_plan', {
			task_id: id,
			rev: 1,
			definition_rev: 1,
			content: i.plan,
			author: ctx.actor.id,
			at: ctx.now
		});
	for (const o of i.serves ?? []) ctx.link('serves', 'task', id, 'objective', o);
	for (const d of i.depends_on ?? []) {
		ctx.get('task', d);
		ctx.link('depends_on', 'task', id, 'task', d);
	}
	ctx.event('task', id, 1, i.decision ? { decision: i.decision } : undefined);
	return id;
}

const NewTask = {
	title: Title,
	description: Text,
	done_when: Text,
	area: opt(Id),
	project: opt(Id),
	milestone: opt(Id),
	serves: opt(Type.Array(Id, { maxItems: 20 })),
	decision: opt(Id),
	depends_on: opt(Type.Array(Id, { maxItems: 50 })),
	agent: opt(Who),
	session: opt(Session),
	plan: opt(Text)
};

/** Would adding task -> on create a cycle? */
export function reaches(ctx: Context, from: string, to: string): boolean {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length) {
		const n = stack.pop()!;
		if (n === to) return true;
		if (seen.has(n)) continue;
		seen.add(n);
		for (const r of ctx.all<{ target_id: string }>(
			"SELECT target_id FROM link WHERE kind = 'depends_on' AND source_id = ?",
			n
		))
			stack.push(r.target_id);
	}
	return false;
}

export const taskCommands = [
	defineCommand({
		name: 'create_task',
		summary: 'Create a Task in an Area or Project, with a definition of done.',
		input: obj(NewTask),
		run(ctx, i) {
			const id = insertTask(ctx, i, placement(ctx, i));
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'create_task_from_activity',
		summary: 'Create a Task that explains untracked activity.',
		input: obj({ ...NewTask, activity: Type.Array(Id, { minItems: 1, maxItems: 100 }) }),
		run(ctx, i) {
			const { activity, ...rest } = i;
			const id = insertTask(ctx, rest, placement(ctx, rest));
			attach(ctx, id, activity);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'attach_activity',
		on: 'task',
		summary: 'Explain untracked activity with an existing Task.',
		input: obj({ activity: Type.Array(Id, { minItems: 1, maxItems: 100 }) }),
		run(ctx, i, t) {
			attach(ctx, t!.id as string, i.activity);
			const v = ctx.update('task', t!.id as string, { updated_at: ctx.now });
			ctx.event('task', t!.id as string, v, { attached: i.activity });
			ctx.done(t!.id as string, v);
		}
	}),
	defineCommand({
		name: 'revise_definition',
		on: 'task',
		summary: "Revise a Task's title, description or done-when. Reopen finished Tasks first.",
		input: obj({ title: opt(Title), description: opt(Text), done_when: opt(Text), reason: Reason }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (FINISHED.includes(t.status))
				reject('task_finished', 'Reopen the Task before revising it', ['reopen']);
			const cur = ctx.one<{ title: string; description: string; done_when: string }>(
				'SELECT * FROM task_definition WHERE task_id = ? AND rev = ?',
				t.id,
				t.definition_rev
			)!;
			const next = {
				title: i.title ?? cur.title,
				description: i.description ?? cur.description,
				done_when: i.done_when ?? cur.done_when
			};
			if (
				next.title === cur.title &&
				next.description === cur.description &&
				next.done_when === cur.done_when
			)
				return ctx.nothing(t.id, t.version);
			const rev = t.definition_rev + 1;
			ctx.insert('task_definition', {
				task_id: t.id,
				rev,
				...next,
				reason: i.reason,
				author: ctx.actor.id,
				at: ctx.now
			});
			const v = ctx.update('task', t.id, { definition_rev: rev, updated_at: ctx.now });
			ctx.event('task', t.id, v, { definition_rev: rev, reason: i.reason });
			ctx.done(t.id, v);
		}
	}),
	defineCommand({
		name: 'revise_plan',
		on: 'task',
		summary: 'Record a new Plan revision for the current definition.',
		input: obj({ content: Text, reason: opt(Reason) }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			const rev =
				(ctx.one<{ r: number | null }>(
					'SELECT max(rev) AS r FROM task_plan WHERE task_id = ?',
					t.id
				)!.r ?? 0) + 1;
			ctx.insert('task_plan', {
				task_id: t.id,
				rev,
				definition_rev: t.definition_rev,
				content: i.content,
				author: ctx.actor.id,
				at: ctx.now
			});
			const v = ctx.update('task', t.id, { updated_at: ctx.now });
			ctx.event('task', t.id, v, { plan_rev: rev, ...(i.reason ? { reason: i.reason } : {}) });
			ctx.done(t.id, v);
		}
	}),
	...(['ready', 'unready'] as const).map((verb) =>
		defineCommand({
			name: verb,
			on: 'task',
			summary:
				verb === 'ready' ? 'Mark an open Task ready to start.' : 'Move a ready Task back to open.',
			input: Empty,
			run(ctx, _i, row) {
				const t = row as unknown as TaskRow;
				const [from, to] = verb === 'ready' ? ['open', 'ready'] : ['ready', 'open'];
				if (t.status === to) return ctx.nothing(t.id, t.version);
				if (t.status !== from) reject('wrong_status', `Task is ${t.status}`);
				setStatus(ctx, t, to);
			}
		})
	),
	defineCommand({
		name: 'assign',
		on: 'task',
		summary:
			'Make an agent accountable for a Task. Taking it from another agent asks that agent first.',
		input: obj({ agent: Who }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (!i.agent.startsWith('agent:')) reject('not_an_agent', 'Tasks are assigned to agents');
			if (t.agent === i.agent) return ctx.nothing(t.id, t.version);
			// An agent taking a Task from another agent needs that agent's agreement; a person may reassign.
			if (t.agent && ctx.actor.kind === 'agent' && t.agent !== ctx.actor.id) {
				const pending = ctx.one(
					"SELECT 1 FROM ask WHERE subject_id = ? AND addressed_to = ? AND status = 'pending'",
					t.id,
					t.agent
				);
				const ask = pending
					? null
					: ctx.ask(
							'task',
							t.id,
							t.agent,
							`${ctx.actor.id} asks to take over this Task`,
							t.session_key
						);
				throw new InputRequired(
					[{ from: t.agent, what: 'Agree to hand over this Task', ...(ask ? { ask } : {}) }],
					t.id
				);
			}
			const v = ctx.update('task', t.id, { agent: i.agent, updated_at: ctx.now });
			ctx.event('task', t.id, v, { agent: i.agent, previous: t.agent });
			ctx.done(t.id, v);
		}
	}),
	defineCommand({
		name: 'start',
		on: 'task',
		summary: 'Start a Task. It needs an accountable agent; claim assigns the caller.',
		input: obj({ claim: opt(Type.Boolean()) }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (t.status === 'in_progress') return ctx.nothing(t.id, t.version);
			if (FINISHED.includes(t.status) || t.status === 'waiting')
				reject(
					'wrong_status',
					`Task is ${t.status}`,
					t.status === 'waiting' ? ['resume'] : ['reopen']
				);
			let agent = t.agent;
			if (!agent) {
				if (!i.claim || ctx.actor.kind !== 'agent')
					reject('no_agent', 'Assign an agent, or start with claim: true as an agent', ['assign']);
				agent = ctx.actor.id;
			}
			warnDependencies(ctx, t);
			setStatus(ctx, t, 'in_progress', { agent });
		}
	}),
	defineCommand({
		name: 'wait',
		on: 'task',
		summary: 'Mark a Task waiting on someone or something, and when to resume.',
		input: obj({
			waiting_for: Text,
			waiting_on: obj({
				kind: Type.Union([
					Type.Literal('agent'),
					Type.Literal('person'),
					Type.Literal('work'),
					Type.Literal('external')
				]),
				ref: Type.String({ minLength: 1, maxLength: 1000 })
			}),
			resume_when: Text,
			follow_up_at: opt(When)
		}),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (FINISHED.includes(t.status)) reject('task_finished', 'Reopen the Task first', ['reopen']);
			setStatus(
				ctx,
				t,
				'waiting',
				{
					prior_status: t.status === 'waiting' ? t.prior_status : t.status,
					waiting_for: i.waiting_for,
					waiting_on_kind: i.waiting_on.kind,
					waiting_on_ref: i.waiting_on.ref,
					resume_when: i.resume_when,
					follow_up_at: i.follow_up_at ?? null
				},
				{ waiting_on: i.waiting_on }
			);
		}
	}),
	defineCommand({
		name: 'resume',
		on: 'task',
		summary: 'Resume a waiting Task in the state it was in before.',
		input: Empty,
		run(ctx, _i, row) {
			const t = row as unknown as TaskRow;
			if (t.status !== 'waiting') return ctx.nothing(t.id, t.version);
			const to = t.prior_status && t.prior_status !== 'waiting' ? t.prior_status : 'open';
			if (to === 'in_progress' && !t.agent)
				reject('no_agent', 'Assign an agent to resume work', ['assign']);
			setStatus(ctx, t, to, {
				prior_status: null,
				waiting_for: null,
				waiting_on_kind: null,
				waiting_on_ref: null,
				resume_when: null,
				follow_up_at: null
			});
		}
	}),
	defineCommand({
		name: 'record_result',
		on: 'task',
		summary: 'Record what a Task produced, with evidence, without completing it.',
		input: obj({ content: Text, sources: Sources }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			const id = ctx.newId();
			ctx.insert('task_result', {
				id,
				task_id: t.id,
				definition_rev: t.definition_rev,
				content: i.content,
				sources: i.sources,
				author: ctx.actor.id,
				at: ctx.now
			});
			const v = ctx.update('task', t.id, { updated_at: ctx.now });
			ctx.event('task', t.id, v, { result: id });
			ctx.done(t.id, v, { result: id });
		}
	}),
	defineCommand({
		name: 'complete',
		on: 'task',
		summary: 'Complete a Task with a Result: an existing one by id, or content and sources.',
		input: obj({ result: opt(Id), content: opt(Text), sources: opt(Sources) }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (t.status === 'completed') return ctx.nothing(t.id, t.version);
			if (t.status === 'abandoned') reject('task_finished', 'The Task is abandoned', ['reopen']);
			let result: string = i.result;
			if (result) {
				const r = ctx.one<{ task_id: string; definition_rev: number }>(
					'SELECT task_id, definition_rev FROM task_result WHERE id = ?',
					result
				);
				if (!r || r.task_id !== t.id) reject('not_found', 'No such Result on this Task');
				if (r!.definition_rev !== t.definition_rev)
					reject('result_stale', 'That Result was written for an older definition', [
						'record_result'
					]);
			} else {
				if (!i.content || !i.sources)
					reject('result_required', 'Give a Result id, or content and at least one source', [
						'record_result'
					]);
				result = ctx.newId();
				ctx.insert('task_result', {
					id: result,
					task_id: t.id,
					definition_rev: t.definition_rev,
					content: i.content,
					sources: i.sources,
					author: ctx.actor.id,
					at: ctx.now
				});
			}
			warnDependencies(ctx, t);
			setStatus(
				ctx,
				t,
				'completed',
				{
					accepted_result_id: result,
					prior_status: null,
					waiting_for: null,
					waiting_on_kind: null,
					waiting_on_ref: null,
					resume_when: null,
					follow_up_at: null
				},
				{ result }
			);
			ctx.resolveAsks(t.id, 'dismissed');
		}
	}),
	defineCommand({
		name: 'reopen',
		on: 'task',
		summary: 'Reopen a completed or abandoned Task.',
		input: obj({ reason: Reason }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (!FINISHED.includes(t.status)) return ctx.nothing(t.id, t.version);
			if (t.milestone_id) {
				const m = ctx.one<{ status: string }>(
					'SELECT status FROM milestone WHERE id = ?',
					t.milestone_id
				)!;
				if (m.status === 'achieved')
					reject('milestone_achieved', 'Its Milestone is achieved; reopen the Milestone first', [
						'reopen_milestone'
					]);
			}
			setStatus(ctx, t, 'open', { accepted_result_id: null }, { reason: i.reason });
		}
	}),
	defineCommand({
		name: 'abandon',
		on: 'task',
		summary: 'Abandon a Task (reversible with reopen).',
		input: obj({ reason: Reason }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (t.status === 'abandoned') return ctx.nothing(t.id, t.version);
			if (t.status === 'completed') reject('task_finished', 'The Task is completed', ['reopen']);
			setStatus(ctx, t, 'abandoned', { prior_status: null }, { reason: i.reason });
			ctx.resolveAsks(t.id, 'dismissed');
		}
	}),
	defineCommand({
		name: 'move_task',
		on: 'task',
		summary: 'Move a Task to another Area or Project (and Milestone).',
		input: obj({ area: opt(Id), project: opt(Id), milestone: opt(Id), reason: Reason }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			const where = placement(ctx, i);
			const v = ctx.update('task', t.id, { ...where, updated_at: ctx.now });
			ctx.event('task', t.id, v, {
				from: { area: t.area_id, project: t.project_id, milestone: t.milestone_id },
				to: where,
				reason: i.reason
			});
			ctx.done(t.id, v);
		}
	}),
	defineCommand({
		name: 'detach_from_milestone',
		on: 'task',
		summary: 'Take a Task out of its Milestone, keeping it in the Project.',
		input: obj({ reason: Reason }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			if (!t.milestone_id) return ctx.nothing(t.id, t.version);
			const v = ctx.update('task', t.id, { milestone_id: null, updated_at: ctx.now });
			ctx.event('task', t.id, v, { detached_from: t.milestone_id, reason: i.reason });
			ctx.done(t.id, v);
		}
	}),
	defineCommand({
		name: 'depend',
		on: 'task',
		summary: 'Record that a Task depends on another (warns, never blocks).',
		input: obj({ on: Id }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			ctx.get('task', i.on);
			if (i.on === t.id || reaches(ctx, i.on, t.id))
				reject('cycle', 'That dependency would make a cycle');
			ctx.link('depends_on', 'task', t.id, 'task', i.on);
			const v = ctx.update('task', t.id, { updated_at: ctx.now });
			ctx.event('task', t.id, v, { depends_on: i.on });
			ctx.done(t.id, v);
		}
	}),
	defineCommand({
		name: 'undepend',
		on: 'task',
		summary: 'Remove a dependency.',
		input: obj({ on: Id }),
		run(ctx, i, row) {
			const t = row as unknown as TaskRow;
			ctx.run(
				"DELETE FROM link WHERE kind = 'depends_on' AND source_id = ? AND target_id = ?",
				t.id,
				i.on
			);
			const v = ctx.update('task', t.id, { updated_at: ctx.now });
			ctx.event('task', t.id, v, { undepends_on: i.on });
			ctx.done(t.id, v);
		}
	})
];

function attach(ctx: Context, task: string, ids: string[]) {
	for (const a of ids) {
		const row = ctx.one<{ task_id: string | null }>('SELECT task_id FROM activity WHERE id = ?', a);
		if (!row) reject('not_found', `No activity ${a}`);
		if (row!.task_id && row!.task_id !== task)
			reject('already_explained', `Activity ${a} already belongs to another Task`);
		ctx.run('UPDATE activity SET task_id = ? WHERE id = ?', task, a);
	}
}
