import { type Context } from '../engine.js';
import { reject } from '../types.js';
import { insertTask, reaches } from './tasks.js';

type PlanTaskInput = {
	key?: string;
	title: string;
	description: string;
	done_when: string;
	depends_on?: string[];
	agent?: string;
	plan?: string;
};
type PlanMilestoneInput = { title: string; success_condition: string; tasks?: PlanTaskInput[] };

/**
 * Add a whole plan to a Project in one step: new Milestones (appended in order) with their Tasks,
 * and Tasks for the Project or its existing Milestones. A Task's `depends_on` names other Tasks in
 * the same plan by `key`, or existing Tasks by id. Returns the new ids by key.
 */
export function addPlan(
	ctx: Context,
	project: string,
	milestones: PlanMilestoneInput[] = [],
	tasks: (PlanTaskInput & { milestone?: string })[] = []
) {
	const p = ctx.get<{ abandoned_at: string | null }>('project', project);
	if (p.abandoned_at) reject('project_abandoned', 'That Project is abandoned', ['resume_project']);
	let position = ctx.one<{ n: number }>(
		'SELECT count(*) AS n FROM milestone WHERE project_id = ?',
		project
	)!.n;
	const placed: { task: PlanTaskInput; milestone: string | null }[] = [];
	const milestoneIds: string[] = [];
	for (const m of milestones) {
		const id = ctx.newId();
		ctx.insert('milestone', {
			id,
			project_id: project,
			title: m.title,
			success_condition: m.success_condition,
			position: ++position,
			status: 'open',
			version: 1
		});
		ctx.event('milestone', id, 1, { project, position });
		milestoneIds.push(id);
		for (const t of m.tasks ?? []) placed.push({ task: t, milestone: id });
	}
	for (const t of tasks) {
		if (t.milestone) {
			const m = ctx.get<{ project_id: string; status: string }>('milestone', t.milestone);
			if (m.project_id !== project)
				reject('placement', 'That Milestone belongs to another Project');
			if (m.status === 'achieved')
				reject('milestone_achieved', 'That Milestone is achieved', ['reopen_milestone']);
		}
		const { milestone, ...task } = t;
		placed.push({ task, milestone: milestone ?? null });
	}

	const byKey = new Map<string, string>();
	for (const { task } of placed)
		if (task.key) {
			if (byKey.has(task.key))
				reject('duplicate_key', `Two Tasks in the plan use key "${task.key}"`);
			byKey.set(task.key, '');
		}
	const created: { id: string; task: PlanTaskInput }[] = [];
	for (const { task, milestone } of placed) {
		const { key, depends_on, ...rest } = task;
		const id = insertTask(ctx, rest, {
			area_id: null,
			project_id: project,
			milestone_id: milestone
		});
		if (key) byKey.set(key, id);
		created.push({ id, task });
	}
	for (const { id, task } of created)
		for (const ref of task.depends_on ?? []) {
			const target = byKey.get(ref) ?? ref;
			ctx.get('task', target);
			if (target === id) reject('dependency_cycle', `"${task.title}" cannot depend on itself`);
			if (reaches(ctx, target, id))
				reject('dependency_cycle', `"${task.title}" would depend on a Task that depends on it`);
			ctx.link('depends_on', 'task', id, 'task', target);
		}
	return {
		milestones: milestoneIds,
		tasks: created.map(({ id, task }) => ({
			id,
			...(task.key ? { key: task.key } : {}),
			title: task.title
		}))
	};
}
