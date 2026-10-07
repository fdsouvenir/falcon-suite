// The spec's promises (docs/work-spec.md), tested against the store. Runs on the built output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Work } from '../dist/store/work.js';

const FRED = { kind: 'human', id: 'person:fred' };
const VERL = { kind: 'agent', id: 'agent:verl' };
const OTTO = { kind: 'agent', id: 'agent:otto' };
const src = [{ ref: 'commit:abc123' }];

function setup() {
	let now = Date.parse('2026-10-01T12:00:00Z');
	const clock = () => new Date(now).toISOString();
	const w = new Work(':memory:', FRED.id, undefined, clock);
	const advance = (hours) => (now += hours * 36e5);
	const ok = (env, actor = VERL) => {
		const r = w.do(env, actor);
		assert.ok(
			r.outcome === 'committed' || r.outcome === 'committed_with_warnings',
			JSON.stringify(r)
		);
		return r;
	};
	const area = ok(
		{ command: 'create_area', input: { title: 'Home', description: 'House systems' } },
		FRED
	).id;
	const task = (input = {}, actor = VERL) =>
		ok(
			{
				command: 'create_task',
				input: {
					title: 'Fix the plunge',
					description: 'd',
					done_when: 'it holds 36F',
					area,
					...input
				}
			},
			actor
		).id;
	return { w, ok, area, task, advance };
}

test('Objectives: only people create and change them; ranks stay dense', () => {
	const { w, ok } = setup();
	assert.equal(
		w.do({ command: 'create_objective', input: { title: 'X', statement: 's' } }, VERL).code,
		'human_only'
	);
	const a = ok({ command: 'create_objective', input: { title: 'A', statement: 's' } }, FRED).id;
	const b = ok({ command: 'create_objective', input: { title: 'B', statement: 's' } }, FRED).id;
	const c = ok({ command: 'create_objective', input: { title: 'C', statement: 's' } }, FRED).id;
	assert.equal(
		w.do({ command: 'set_autonomy', id: a, input: { autonomy: 'act' } }, FRED).code,
		'limits_required'
	);
	ok({ command: 'retire_objective', id: a, input: {} }, FRED);
	assert.deepEqual(
		w.reads.objectives().map((o) => [o.title, o.rank]),
		[
			['B', 1],
			['C', 2]
		]
	);
	ok({ command: 'rank_objectives', input: { order: [c, b] } }, FRED);
	assert.deepEqual(
		w.reads.objectives().map((o) => o.title),
		['C', 'B']
	);
	assert.equal(
		w.do({ command: 'rank_objectives', input: { order: [c] } }, FRED).code,
		'incomplete_ranking'
	);
});

test('Agents need a decided Decision before creating Work toward a propose Objective', () => {
	const { w, ok, task, area } = setup();
	const o = ok(
		{ command: 'create_objective', input: { title: 'Revenue', statement: 's' } },
		FRED
	).id;
	assert.equal(
		w.do(
			{
				command: 'create_task',
				input: { title: 't', description: 'd', done_when: 'x', area, serves: [o] }
			},
			VERL
		).code,
		'proposal_required'
	);
	const d = ok({
		command: 'raise_decision',
		input: {
			prompt: 'Draft the pilot offer?',
			options: [
				{ id: 'yes', label: 'Yes' },
				{ id: 'no', label: 'No' }
			],
			recommendation: { option: 'yes', rationale: 'unblocks the thesis' },
			deciders: [FRED.id],
			consequence_of_no_decision: 'nothing moves',
			targets: [{ kind: 'objective', id: o }]
		}
	}).id;
	assert.equal(
		w.do(
			{
				command: 'create_task',
				input: { title: 't', description: 'd', done_when: 'x', area, serves: [o], decision: d }
			},
			VERL
		).code,
		'proposal_required',
		'still pending'
	);
	ok({ command: 'decide', id: d, input: { option: 'yes' } }, FRED);
	task({ serves: [o], decision: d });
	task({ serves: [o] }, FRED); // people need no proposal
	ok({ command: 'set_autonomy', id: o, input: { autonomy: 'act', limits: 'no spending' } }, FRED);
	task({ serves: [o] }); // act: no proposal needed
});

test('Task lifecycle: start needs an agent, wait remembers, complete needs evidence', () => {
	const { w, ok, task } = setup();
	const t = task();
	assert.equal(w.do({ command: 'start', id: t, input: {} }, FRED).code, 'no_agent');
	ok({ command: 'start', id: t, input: { claim: true } });
	assert.equal(w.reads.get(t).agent, VERL.id);
	assert.equal(
		w.do({ command: 'wait', id: t, input: { waiting_for: 'x' } }, VERL).code,
		'invalid_input'
	);
	ok({
		command: 'wait',
		id: t,
		input: {
			waiting_for: 'Fred to buy a tub sensor',
			waiting_on: { kind: 'person', ref: FRED.id },
			resume_when: 'sensor arrives',
			follow_up_at: '2026-10-03T00:00:00Z'
		}
	});
	ok({ command: 'resume', id: t, input: {} });
	assert.equal(w.reads.get(t).status, 'in_progress');
	assert.equal(
		w.do({ command: 'complete', id: t, input: { content: 'done' } }, VERL).code,
		'result_required'
	);
	assert.equal(
		w.do({ command: 'complete', id: t, input: { content: 'done', sources: [] } }, VERL).code,
		'invalid_input'
	);
	ok({ command: 'complete', id: t, input: { content: 'v4.1.0 deployed', sources: src } });
	assert.equal(
		w.do({ command: 'complete', id: t, input: { content: 'again', sources: src } }, VERL).outcome,
		'noop'
	);
	assert.equal(
		w.do({ command: 'revise_definition', id: t, input: { title: 'x', reason: 'r' } }, VERL).code,
		'task_finished'
	);
	ok({ command: 'reopen', id: t, input: { reason: 'regressed' } });
	ok({
		command: 'revise_definition',
		id: t,
		input: { done_when: 'it holds 35F', reason: 'Fred lowered the floor' }
	});
	const d = w.reads.get(t);
	assert.equal(d.definitions.length, 2);
	assert.equal(d.definitions[0].done_when, 'it holds 36F', 'revisions are immutable');
});

test('Results pin the definition they were written for', () => {
	const { w, ok, task } = setup();
	const t = task();
	ok({ command: 'start', id: t, input: { claim: true } });
	const r = ok({ command: 'record_result', id: t, input: { content: 'draft', sources: src } }).data
		.result;
	ok({
		command: 'revise_definition',
		id: t,
		input: { title: 'Fix the plunge properly', reason: 'scope grew' }
	});
	assert.equal(
		w.do({ command: 'complete', id: t, input: { result: r } }, VERL).code,
		'result_stale'
	);
});

test('Dependencies warn, never block; cycles are refused', () => {
	const { w, ok, task } = setup();
	const a = task();
	const b = task({ depends_on: [a] });
	const r = ok({ command: 'start', id: b, input: { claim: true } });
	assert.equal(r.outcome, 'committed_with_warnings');
	assert.equal(r.warnings[0].code, 'dependency_unfinished');
	assert.equal(w.do({ command: 'depend', id: a, input: { on: b } }, VERL).code, 'cycle');
	assert.match(w.reads.blockedBy(b)[0], /depends on/);
});

test('Milestones cannot be achieved over unfinished Work; Project status is derived', () => {
	const { w, ok, area } = setup();
	const p = ok({
		command: 'create_project',
		input: {
			title: 'Cold plunge v4',
			outcome: 'reactive controller',
			area,
			milestones: [{ title: 'Live', success_condition: 'runs a night' }]
		}
	}).id;
	const m = w.reads.get(p).milestones[0].id;
	const t = ok({
		command: 'create_task',
		input: { title: 'Rewrite', description: 'd', done_when: 'x', project: p, milestone: m }
	}).id;
	const refused = w.do(
		{ command: 'achieve_milestone', id: m, input: { basis: 'b', sources: src } },
		VERL
	);
	assert.equal(refused.code, 'milestone_has_open_work');
	assert.ok(refused.next.includes('detach_from_milestone'));
	assert.equal(w.reads.warnings(w.now()).filter((x) => x.kind === 'milestone_ready').length, 0);
	ok({ command: 'start', id: t, input: { claim: true } });
	ok({ command: 'complete', id: t, input: { content: 'deployed', sources: src } });
	assert.equal(w.reads.warnings(w.now()).filter((x) => x.kind === 'milestone_ready').length, 1);
	ok({ command: 'achieve_milestone', id: m, input: { basis: 'ran all night', sources: src } });
	assert.equal(w.reads.get(p).status, 'completed');
	assert.equal(
		w.do({ command: 'reopen', id: t, input: { reason: 'x' } }, VERL).code,
		'milestone_achieved'
	);
	ok({ command: 'reopen_milestone', id: m, input: { reason: 'regression' } });
	assert.equal(w.reads.get(p).status, 'open');
});

test('Abandoning a Project never silently changes its unfinished Tasks', () => {
	const { w, ok, area } = setup();
	const p = ok({ command: 'create_project', input: { title: 'P', outcome: 'o', area } }).id;
	const a = ok({
		command: 'create_task',
		input: { title: 'a', description: 'd', done_when: 'x', project: p }
	}).id;
	const b = ok({
		command: 'create_task',
		input: { title: 'b', description: 'd', done_when: 'x', project: p }
	}).id;
	const byAgent = w.do(
		{
			command: 'abandon_project',
			id: p,
			input: { reason: 'pivot', dispositions: { [a]: 'abandon', [b]: 'detach' } }
		},
		VERL
	);
	assert.equal(byAgent.code, 'human_only', 'agents do not abandon Projects');
	const r = w.do(
		{
			command: 'abandon_project',
			id: p,
			input: { reason: 'pivot', dispositions: { [a]: 'abandon' } }
		},
		FRED
	);
	assert.equal(r.code, 'dispositions_required');
	assert.equal(r.next.length, 1);
	assert.equal(w.reads.get(a).status, 'open', 'nothing applied');
	assert.equal(w.reads.get(p).status, 'open');
	assert.equal(w.reads.needsYou(FRED.id, w.now()).asks.length, 0, 'no Asks filed');
	ok(
		{
			command: 'abandon_project',
			id: p,
			input: { reason: 'pivot', dispositions: { [a]: 'abandon', [b]: 'detach' } }
		},
		FRED
	);
	assert.equal(w.reads.get(a).status, 'abandoned');
	assert.equal(w.reads.get(b).area_id, area);
	assert.equal(w.reads.get(p).status, 'abandoned');
});

test('Only a person takes a Task from another agent', () => {
	const { w, ok, task } = setup();
	const t = task({ agent: OTTO.id });
	const r = w.do({ command: 'assign', id: t, input: { agent: VERL.id } }, VERL);
	assert.equal(r.code, 'not_yours', JSON.stringify(r));
	assert.equal(w.reads.get(t).agent, OTTO.id);
	assert.equal(w.reads.brief(OTTO.id, null, w.now()).asks_for_you.length, 0);
	ok({ command: 'assign', id: t, input: { agent: VERL.id } }, FRED);
});

test('Questions: Asks for people, answers kept, hypotheses accepted only as such', () => {
	const { w, ok, task, advance } = setup();
	const t = task();
	const q = ok({
		command: 'raise_question',
		input: {
			prompt: 'Which model to fall back to?',
			impact: 'I stop during blackouts',
			answerable_by: [FRED.id],
			targets: [{ kind: 'task', id: t }],
			hypothesis: 'openai/gpt-5.5'
		}
	}).id;
	assert.equal(w.reads.needsYou(FRED.id, w.now()).asks.length, 1);
	assert.match(w.reads.blockedBy(t)[0], /open Question/);
	assert.equal(
		w.do({ command: 'answer', id: q, input: { answer: 'x' } }, VERL).code,
		'not_answerable'
	);
	assert.equal(w.do({ command: 'accept_hypothesis', id: q, input: {} }, VERL).code, 'human_only');
	const since = w.now();
	advance(1);
	ok({ command: 'accept_hypothesis', id: q, input: {} }, FRED);
	const d = w.reads.get(q);
	assert.equal(d.status, 'answered');
	assert.equal(d.answers[0].text, 'openai/gpt-5.5');
	assert.equal(d.answers[0].confidence, 'confirmed');
	assert.equal(d.answers[0].accepted_hypothesis, 1);
	assert.equal(w.reads.needsYou(FRED.id, w.now()).asks.length, 0);
	assert.deepEqual(w.reads.blockedBy(t), []);
	ok({ command: 'answer', id: q, input: { answer: 'anthropic/claude-sonnet-5-5' } }, FRED);
	assert.equal(w.reads.get(q).answers.length, 2, 'earlier answer kept');
	assert.equal(w.reads.brief(VERL.id, since, w.now()).resolved_for_you.length, 2);
});

test('Decisions: people may decide without a reason, agents may not; only deciders decide', () => {
	const { w, ok } = setup();
	const raise = (deciders) =>
		ok({
			command: 'raise_decision',
			input: {
				prompt: 'Apply --clear-tools?',
				options: [
					{ id: 'apply', label: 'Apply' },
					{ id: 'wait', label: 'Wait' }
				],
				recommendation: { option: 'apply', rationale: 'reversible' },
				deciders,
				consequence_of_no_decision: 'jobs keep failing'
			}
		}).id;
	const d = raise([FRED.id]);
	assert.equal(
		w.do({ command: 'decide', id: d, input: { option: 'apply' } }, VERL).code,
		'not_a_decider'
	);
	assert.equal(
		w.do({ command: 'decide', id: d, input: { option: 'nope' } }, FRED).code,
		'unknown_option'
	);
	ok({ command: 'decide', id: d, input: { option: 'apply' } }, FRED);
	assert.equal(w.reads.needsYou(FRED.id, w.now()).asks.length, 0);
	const e = raise([VERL.id]);
	assert.equal(
		w.do({ command: 'decide', id: e, input: { option: 'apply' } }, VERL).code,
		'rationale_required'
	);
	ok(
		{ command: 'decide', id: e, input: { option: 'apply', rationale: 'neither job needs tools' } },
		VERL
	);
	assert.equal(
		w.do(
			{
				command: 'raise_decision',
				input: {
					prompt: 'p',
					options: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' }
					],
					recommendation: { option: 'c', rationale: 'r' },
					deciders: [FRED.id],
					consequence_of_no_decision: 'c'
				}
			},
			VERL
		).code,
		'unknown_option'
	);
});

test('Discussion sessions: a person’s choice wins, and Asks fall back to the Project’s', () => {
	const { w, ok, area } = setup();
	const p = ok({
		command: 'create_project',
		input: { title: 'P', outcome: 'o', area, session: 'agent:main:dashboard:proj' }
	}).id;
	const t = ok({
		command: 'create_task',
		input: { title: 't', description: 'd', done_when: 'x', project: p }
	}).id;
	ok({
		command: 'raise_question',
		input: {
			prompt: 'q?',
			impact: 'i',
			answerable_by: [FRED.id],
			targets: [{ kind: 'task', id: t }]
		}
	});
	assert.equal(w.reads.needsYou(FRED.id, w.now()).asks[0].session, 'agent:main:dashboard:proj');
	ok(
		{
			command: 'set_session',
			input: { kind: 'task', id: t, session: 'agent:main:dashboard:fred' }
		},
		FRED
	);
	assert.equal(
		w.do(
			{
				command: 'set_session',
				input: { kind: 'task', id: t, session: 'agent:main:dashboard:mine' }
			},
			VERL
		).code,
		'human_choice'
	);
});

test('Commands are idempotent per key and refuse stale versions', () => {
	const { w, task } = setup();
	const t = task();
	const env = { command: 'ready', id: t, idempotency_key: 'k1', input: {} };
	const first = w.do(env, VERL);
	assert.deepEqual(w.do(env, VERL), first);
	assert.equal(w.reads.get(t).history.filter((e) => e.command === 'ready').length, 1);
	assert.equal(w.do({ ...env, input: {}, command: 'unready' }, VERL).code, 'idempotency_conflict');
	assert.equal(
		w.do({ command: 'unready', id: t, expected_version: 1, input: {} }, VERL).code,
		'stale_version'
	);
});

test('Activity: attached to the in-progress Task, else untracked; Warnings need no reporting', () => {
	const { w, ok, task, advance } = setup();
	const o = ok(
		{ command: 'create_objective', input: { title: 'Revenue', statement: 's' } },
		FRED
	).id;
	const t = task();
	assert.equal(
		w.recordActivity({ agent: VERL.id, kind: 'file', summary: 'edited USER.md' }).task,
		null
	);
	ok({ command: 'start', id: t, input: { claim: true } });
	assert.equal(
		w.recordActivity({ agent: VERL.id, kind: 'commit', summary: 'committed', ref: 'abc' }).task,
		t
	);
	const untracked = w.reads.activity({ untracked: true }).activity;
	assert.equal(untracked.length, 1);
	ok({ command: 'attach_activity', id: t, input: { activity: [untracked[0].id] } });
	assert.equal(w.reads.activity({ untracked: true }).activity.length, 0);
	advance(24 * 8);
	const kinds = w.reads
		.warnings(w.now())
		.map((x) => x.kind)
		.sort();
	assert.deepEqual(kinds, ['objective_without_progress', 'stalled_task']);
	assert.equal(
		w.reads.warnings(w.now()).find((x) => x.kind === 'objective_without_progress').object.id,
		o
	);
});

test('The database refuses data it did not create', () => {
	const dir = mkdtempSync(join(tmpdir(), 'falcon-work-'));
	const file = join(dir, 'work.db');
	const foreign = new DatabaseSync(file);
	foreign.exec('CREATE TABLE objects (id TEXT)');
	foreign.close();
	assert.throws(() => new Work(file, FRED.id), /did not create/);
	const fresh = join(dir, 'fresh.db');
	new Work(fresh, FRED.id).close();
	new Work(fresh, FRED.id).close(); // reopening our own is fine
	writeFileSync(join(dir, 'x'), '');
});
