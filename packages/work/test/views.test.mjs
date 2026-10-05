// Screen projections: each screen's data in one read, with the spec's rules visible in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Work } from '../dist/store/work.js';

const FRED = { kind: 'human', id: 'person:fred' };
const VERL = { kind: 'agent', id: 'agent:verl' };
const src = [{ ref: 'commit:abc' }];

function world() {
	const w = new Work(':memory:', FRED.id);
	const ok = (env, actor = VERL) => {
		const r = w.do(env, actor);
		assert.ok(r.outcome.startsWith('committed'), JSON.stringify(r));
		return r.id;
	};
	const o = ok(
		{
			command: 'create_objective',
			input: { title: 'Revenue', statement: 's', session: 'agent:main:dashboard:obj' }
		},
		FRED
	);
	ok({ command: 'set_autonomy', id: o, input: { autonomy: 'act', limits: 'no spending' } }, FRED);
	const area = ok({ command: 'create_area', input: { title: 'Platform', description: 'd' } }, FRED);
	const p = ok({
		command: 'create_project',
		input: {
			title: 'Backend 2.0',
			outcome: 'o',
			area,
			serves: [o],
			session: 'agent:main:dashboard:proj',
			milestones: [{ title: 'M1', success_condition: 'sc' }]
		}
	});
	const m = w.reads.get(p).milestones[0].id;
	const t1 = ok({
		command: 'create_task',
		input: { title: 'Auth', description: 'd', done_when: 'x', project: p, milestone: m }
	});
	const t2 = ok({
		command: 'create_task',
		input: {
			title: 'First Job',
			description: 'd',
			done_when: 'x',
			project: p,
			milestone: m,
			depends_on: [t1]
		}
	});
	ok({ command: 'start', id: t1, input: { claim: true } });
	const d = ok({
		command: 'raise_decision',
		input: {
			prompt: 'Which store?',
			options: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' }
			],
			recommendation: { option: 'a', rationale: 'r' },
			deciders: [FRED.id],
			consequence_of_no_decision: 'c',
			targets: [{ kind: 'task', id: t2 }]
		}
	});
	const q = ok({
		command: 'raise_question',
		input: { prompt: 'Which model?', impact: 'i', answerable_by: [FRED.id], hypothesis: 'gpt-5.5' }
	});
	w.recordActivity({ agent: 'agent:otto', kind: 'file', summary: 'edited USER.md' }); // otto has no Task in progress
	return { w, o, area, p, m, t1, t2, d, q };
}

test('overview: what needs the person, what is happening, and sessions with fallback', () => {
	const { w, t1, d, q } = world();
	const v = w.views.overview(FRED.id, w.now());
	assert.deepEqual(
		v.needs_you.decisions.map((x) => x.id),
		[d]
	);
	assert.equal(
		v.needs_you.decisions[0].session.key,
		'agent:main:dashboard:proj',
		'falls back through the Task to its Project'
	);
	assert.deepEqual(
		v.needs_you.questions.map((x) => x.id),
		[q]
	);
	assert.equal(v.needs_you.questions[0].hypothesis, 'gpt-5.5');
	assert.deepEqual(
		v.now.map((x) => x.id),
		[t1]
	);
	assert.deepEqual(v.now[0].session, { key: 'agent:main:dashboard:proj', from: 'project' });
	assert.equal(v.untracked.count, 1);
	assert.equal(v.objectives[0].serving.projects[0].tasks_total, 2);
	assert.equal(
		w.views.overview('person:other', w.now()).needs_you.decisions.length,
		0,
		'only deciders see a Decision'
	);
});

test('areas, project and objective pages carry the closure rule and dependencies', () => {
	const { w, area, p, o, t2, d } = world();
	const a = w.views.areas(FRED.id);
	assert.equal(a.areas[0].projects, 1);
	assert.equal(a.areas[0].open_tasks, 2);
	const proj = w.views.project(p, FRED.id);
	assert.equal(proj.area.id, area);
	assert.equal(proj.milestones[0].tasks_done, 0);
	assert.equal(proj.milestones[0].tasks.find((t) => t.id === t2).depends_on[0].title, 'Auth');
	assert.ok(proj.about.some((x) => x.id === d));
	const obj = w.views.objective(o, FRED.id);
	assert.equal(obj.serving.projects[0].id, p);
	assert.equal(obj.needs_you[0].id, d);
	assert.equal(obj.autonomy, 'act');
});

test('feed merges changes and captured activity; panel shows a Task in full', () => {
	const { w, t1, t2 } = world();
	const feed = w.views.feed({});
	assert.ok(feed.items.some((x) => x.type === 'activity' && x.untracked));
	assert.ok(feed.items.some((x) => x.type === 'change' && x.command === 'start'));
	assert.equal(w.views.feed({ filter: 'untracked' }).items.length, 1);
	const panel = w.views.panel(t1, FRED.id);
	assert.equal(panel.card.status, 'in_progress');
	assert.deepEqual(
		panel.needed_by.map((x) => x.id),
		[t2]
	);
	assert.equal(panel.milestone.position, 1);
});
