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
	w.recordTurn({ agent: 'agent:otto', outcomes: [{ kind: 'file', label: 'USER.md' }], by: 'work' }); // unfiled
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
	assert.equal(v.happening[0].id, t1);
	assert.deepEqual(v.happening[0].session, { key: 'agent:main:dashboard:proj', from: 'project' });
	assert.deepEqual(v.summary, { decide: 1, answer: 1, todo: 0, in_progress: 1 });
	assert.equal(v.unfiled.count, 1);
	assert.equal(v.objectives[0].serving.projects[0].tasks_total, 2);
	assert.equal(
		w.views.overview('person:other', w.now()).needs_you.decisions.length,
		0,
		'only deciders see a Decision'
	);
});

test('overview: one entry per thing that needs the person; warnings become ages or Heads up', () => {
	const { w, t1, d } = world();
	const ok = (env, actor = VERL) => {
		const r = w.do(env, actor);
		assert.ok(r.outcome.startsWith('committed'), JSON.stringify(r));
		return r.id;
	};
	const wait = (id) =>
		ok({
			command: 'wait',
			id,
			input: {
				waiting_for: 'Fred',
				waiting_on: { kind: 'person', ref: FRED.id },
				resume_when: 'done',
				follow_up_at: '2000-01-01T00:00:00Z'
			}
		});
	// Waiting on Fred with nothing else asking him: a thing to do.
	wait(t1);
	let v = w.views.overview(FRED.id, w.now());
	assert.deepEqual(
		v.needs_you.todo.map((x) => x.id),
		[t1]
	);
	assert.ok(!v.happening.some((x) => x.id === t1), 'listed once, under Needs you');
	assert.ok(
		!v.heads_up.some((x) => x.kind === 'follow_up_overdue'),
		'the overdue follow-up is the age of the Do item'
	);
	assert.ok(!v.heads_up.some((x) => x.kind === 'unanswered'));
	assert.equal(v.needs_you.count, 3);

	// The same Task held by one of Fred's Decisions: the Decision covers it.
	ok({ command: 'resume', id: t1 });
	ok({
		command: 'raise_decision',
		input: {
			prompt: 'Go ahead?',
			options: [
				{ id: 'y', label: 'Yes' },
				{ id: 'n', label: 'No' }
			],
			recommendation: { option: 'y', rationale: 'r' },
			deciders: [FRED.id],
			consequence_of_no_decision: 'c',
			targets: [{ kind: 'task', id: t1 }]
		}
	});
	wait(t1);
	v = w.views.overview(FRED.id, w.now());
	assert.equal(v.needs_you.todo.length, 0);
	assert.equal(v.happening.find((x) => x.id === t1).waiting_on_you, 'decision');
	assert.ok(v.needs_you.decisions.some((x) => x.id === d));

	const panel = w.views.panel(d, FRED.id);
	assert.deepEqual(
		panel.for.map((x) => x.title),
		['First Job']
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

test('feed is every timeline, newest first; panel shows a Task in full', () => {
	const { w, t1, t2 } = world();
	const feed = w.views.feed({});
	assert.equal(feed.items.length, 1);
	assert.equal(feed.items[0].task, null);
	assert.equal(feed.unfiled_count, 1);
	assert.equal(w.views.feed({ filter: 'unfiled' }).items.length, 1);
	const panel = w.views.panel(t1, FRED.id);
	assert.equal(panel.card.status, 'in_progress');
	assert.deepEqual(
		panel.needed_by.map((x) => x.id),
		[t2]
	);
	assert.equal(panel.milestone.position, 1);
});

test('Areas & Projects leaves out abandoned Tasks', () => {
	const w = new Work(':memory:', FRED.id);
	const area = w.do(
		{ command: 'create_area', input: { title: 'Home', description: 'd' } },
		VERL
	).id;
	const mk = (title) =>
		w.do({ command: 'create_task', input: { title, description: 'd', done_when: 'x', area } }, VERL)
			.id;
	mk('Keep me');
	const gone = mk('Mistaken test');
	w.do({ command: 'abandon', id: gone, input: { reason: 'test' } }, VERL);
	const shown = w.views.areas(FRED.id).groups[0].tasks.map((t) => t.title);
	assert.deepEqual(shown, ['Keep me']);
});
