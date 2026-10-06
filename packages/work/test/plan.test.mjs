// A whole plan in one command: Milestones with their Tasks and dependencies (commands §plans),
// and a brief that shows the agent where work already lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Work } from '../dist/store/work.js';
import { renderBrief, GUIDANCE } from '../dist/plugin/brief.js';

const FRED = { kind: 'human', id: 'person:fred' };
const VERL = { kind: 'agent', id: 'agent:verl' };

function setup() {
	const w = new Work(':memory:', FRED.id);
	const area = w.do(
		{ command: 'create_area', input: { title: 'Marketing', description: 'd' } },
		VERL
	).id;
	return { w, area };
}
const t = (key, title, depends_on) => ({
	key,
	title,
	description: 'd',
	done_when: 'x',
	...(depends_on ? { depends_on } : {})
});

test('create_project takes the whole plan, with dependencies by key', () => {
	const { w, area } = setup();
	const r = w.do(
		{
			command: 'create_project',
			input: {
				title: 'Paid pilot',
				outcome: 'o',
				area,
				milestones: [
					{ title: 'Qualified', success_condition: 's', tasks: [t('a', 'Discovery call')] },
					{
						title: 'Signed',
						success_condition: 's',
						tasks: [t('b', 'Proposal', ['a']), t('c', 'Contract', ['b'])]
					}
				]
			}
		},
		VERL
	);
	assert.equal(r.outcome, 'committed', JSON.stringify(r));
	assert.equal(r.data.tasks.length, 3);
	const p = w.reads.get(r.id);
	assert.deepEqual(
		p.milestones.map((m) => [m.title, m.tasks.length]),
		[
			['Qualified', 1],
			['Signed', 2]
		]
	);
	const contract = r.data.tasks.find((x) => x.key === 'c').id;
	const proposal = r.data.tasks.find((x) => x.key === 'b').id;
	assert.deepEqual(w.reads.get(contract).depends_on, [proposal]);
});

test('plan_project extends an existing Project, including its existing Milestones', () => {
	const { w, area } = setup();
	const p = w.do(
		{
			command: 'create_project',
			input: {
				title: 'P',
				outcome: 'o',
				area,
				milestones: [{ title: 'M1', success_condition: 's' }]
			}
		},
		VERL
	).id;
	const m1 = w.reads.get(p).milestones[0].id;
	const existing = w.do(
		{
			command: 'create_task',
			input: { title: 'Old', description: 'd', done_when: 'x', project: p, milestone: m1 }
		},
		VERL
	).id;
	const r = w.do(
		{
			command: 'plan_project',
			id: p,
			input: {
				tasks: [{ ...t('x', 'In M1', [existing]), milestone: m1 }],
				milestones: [{ title: 'M2', success_condition: 's', tasks: [t('y', 'In M2', ['x'])] }]
			}
		},
		VERL
	);
	assert.ok(r.outcome.startsWith('committed'), JSON.stringify(r));
	const after = w.reads.get(p);
	assert.deepEqual(
		after.milestones.map((m) => [m.position, m.title, m.tasks.length]),
		[
			[1, 'M1', 2],
			[2, 'M2', 1]
		]
	);
});

test('a plan is all or nothing: duplicate keys and cycles are refused', () => {
	const { w, area } = setup();
	const p = w.do({ command: 'create_project', input: { title: 'P', outcome: 'o', area } }, VERL).id;
	const dup = w.do(
		{ command: 'plan_project', id: p, input: { tasks: [t('a', 'One'), t('a', 'Two')] } },
		VERL
	);
	assert.equal(dup.code, 'duplicate_key');
	const cycle = w.do(
		{
			command: 'plan_project',
			id: p,
			input: { tasks: [t('a', 'One', ['b']), t('b', 'Two', ['a'])] }
		},
		VERL
	);
	assert.equal(cycle.code, 'dependency_cycle');
	assert.equal(w.reads.get(p).tasks.length, 0, 'nothing from a refused plan remains');
});

test('the brief shows Areas and their open Projects; the guidance stays short', () => {
	const { w, area } = setup();
	w.do(
		{
			command: 'create_project',
			input: {
				title: 'Home AI Solutions: first paid pilot',
				outcome: 'o',
				area,
				milestones: [{ title: 'Thesis written', success_condition: 's' }]
			}
		},
		VERL
	);
	const brief = renderBrief(w.reads, VERL.id, null, w.now());
	assert.match(brief, /Marketing/);
	assert.match(brief, /Home AI Solutions: first paid pilot .*Milestone 1\/1 "Thesis written"/);
	assert.match(GUIDANCE, /Objectives .*Areas .*Projects .*Tasks/s);
	assert.ok(GUIDANCE.length < 700, 'the guidance explains Work; the tools explain themselves');
});
