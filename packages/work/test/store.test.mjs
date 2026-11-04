// The 2.0 store (spec §2, §4): Jobs, Projects, Tasks, Needs you, and people's entries winning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Work } from '../dist/store/work.js';
import { setAsideWork5 } from '../dist/store/db.js';
import { CLERK } from '../dist/store/types.js';

const FRED = { kind: 'human', id: 'person:gateway-owner' };
const WILL = { kind: 'agent', id: 'agent:william' };

function world() {
	const w = new Work(':memory:', FRED.id, () => new Date().toISOString());
	const ok = (env, actor = WILL) => {
		const r = w.do(env, actor);
		assert.ok(r.outcome.startsWith('committed'), JSON.stringify(r));
		return r.id;
	};
	return { w, ok };
}

test('a Task is standalone, in a Project, or in a Job — never both', () => {
	const { w, ok } = world();
	const p = ok({
		command: 'create_project',
		input: { title: 'Catalog import refactor', outcome: 'New importer live' }
	});
	const j = ok({
		command: 'create_job',
		input: { title: 'Support inbox', instructions: 'Draft replies' }
	});
	ok({ command: 'create_task', input: { title: 'Alone', description: 'd', done_when: 'x' } });
	ok({
		command: 'create_task',
		input: { title: 'In project', description: 'd', done_when: 'x', project: p }
	});
	ok({
		command: 'create_task',
		input: { title: 'In job', description: 'd', done_when: 'x', job: j }
	});
	const both = w.do(
		{
			command: 'create_task',
			input: { title: 'Both', description: 'd', done_when: 'x', project: p, job: j }
		},
		WILL
	);
	assert.equal(both.outcome, 'rejected');
});

test('the board shows Jobs and Projects as one card each; only standalone Tasks get their own', () => {
	const { w, ok } = world();
	const p = ok({
		command: 'create_project',
		input: {
			title: 'Refactor',
			outcome: 'o',
			milestones: [
				{
					title: 'Parse',
					success_condition: 's',
					tasks: [{ title: 'Rewrite parser', description: 'd', done_when: 'x' }]
				}
			]
		}
	});
	const j = ok({
		command: 'create_job',
		input: { title: 'Support inbox', instructions: 'Draft replies' }
	});
	ok({
		command: 'create_task',
		input: { title: 'Reply to Dana', description: 'd', done_when: 'x', job: j }
	});
	const t = ok({
		command: 'create_task',
		input: { title: 'Install gcloud', description: 'd', done_when: 'x', agent: 'agent:william' }
	});
	ok({ command: 'start', id: t, input: {} });
	const b = w.views.board();
	const titles = [...b.moving, ...b.waiting].map((c) => `${c.kind}:${c.title}`).sort();
	assert.deepEqual(titles, ['job:Support inbox', 'project:Refactor', 'task:Install gcloud']);
	const project = b.moving.find((c) => c.id === p);
	assert.equal(project.milestone.title, 'Parse');
	assert.deepEqual(project.tasks, { done: 0, total: 1, open: 1 });
});

test('Needs you holds open Questions and Decisions for the person, with their session; items there leave the board', () => {
	const { w, ok } = world();
	const t = ok({
		command: 'create_task',
		input: { title: 'Reduce Xfinity bill', description: 'd', done_when: 'x' }
	});
	ok({
		command: 'raise_question',
		input: {
			prompt: 'Resume or keep paused?',
			impact: 'i',
			answerable_by: [FRED.id],
			targets: [{ kind: 'task', id: t }],
			session: 'agent:main:dashboard:x'
		}
	});
	const n = w.views.needsYou();
	assert.equal(n.length, 1);
	assert.equal(n[0].session, 'agent:main:dashboard:x');
	assert.equal(n[0].about.title, 'Reduce Xfinity bill');
	assert.ok(![...w.views.board().moving, ...w.views.board().waiting].some((c) => c.id === t));
});

test("Work never overwrites a field a person or agent set; the agent's status line wins", () => {
	const { w, ok } = world();
	const t = ok(
		{ command: 'create_task', input: { title: 'T', description: 'd', done_when: 'x' } },
		CLERK
	);
	ok({ command: 'set_status_line', input: { item: t, status_line: 'Work wrote this' } }, CLERK);
	ok({ command: 'set_status_line', input: { item: t, status_line: 'The agent says this' } }, WILL);
	const r = w.do(
		{ command: 'set_status_line', input: { item: t, status_line: 'Work tries again' } },
		CLERK
	);
	assert.equal(r.outcome, 'noop');
	assert.equal(w.views.task(t).status_line, 'The agent says this');
	// …but Work may still revise what only Work wrote.
	const def = w.do(
		{ command: 'revise_definition', id: t, input: { title: 'Better title' } },
		CLERK
	);
	assert.equal(def.outcome, 'committed');
	assert.equal(w.views.task(t).title, 'Better title');
});

test('a Task that grew a second deliverable becomes a Project, keeping its sessions', () => {
	const { w, ok } = world();
	const t = ok({
		command: 'create_task',
		input: { title: 'Link takes over gog', description: 'd', done_when: 'x' }
	});
	w.linkSession(t, 'task', 'agent:william:dashboard:a');
	const r = w.do(
		{
			command: 'promote_to_project',
			id: t,
			input: { outcome: 'Link owns gog and shows permissions' }
		},
		CLERK
	);
	assert.equal(r.outcome, 'committed');
	const p = w.views.project(r.data.project);
	assert.equal(p.title, 'Link takes over gog');
	assert.equal(p.other_tasks[0].id, t);
	assert.equal(p.sessions[0].key, 'agent:william:dashboard:a');
});

test('Jobs link their automations, and runs of those automations belong to the Job', () => {
	const { w, ok } = world();
	const j = ok({
		command: 'create_job',
		input: {
			title: 'Support inbox',
			instructions: 'Draft replies',
			automations: [{ id: 'cron-123', name: 'Inbox watcher' }]
		}
	});
	assert.equal(w.jobForAutomation('cron-123'), j);
	assert.equal(w.views.job(j).automations[0].name, 'Inbox watcher');
	const other = ok({ command: 'create_job', input: { title: 'Other', instructions: 'x' } });
	assert.equal(
		w.do({ command: 'link_automation', id: other, input: { id: 'cron-123' } }, WILL).outcome,
		'rejected'
	);
});

test('history entries file under items, link their session, and feed What happened', () => {
	const { w, ok } = world();
	const t = ok({ command: 'create_task', input: { title: 'T', description: 'd', done_when: 'x' } });
	w.recordEntry({
		agent: 'agent:william',
		item: { id: t, kind: 'task' },
		session: 's1',
		run: 'r1',
		outcomes: [],
		summary: 'Parsing done.',
		by: 'work'
	});
	w.recordEntry({
		agent: 'agent:william',
		item: { id: t, kind: 'task' },
		session: 's1',
		run: 'r1',
		outcomes: [],
		summary: 'Parsing done.',
		by: 'work'
	});
	const h = w.views.happened(null);
	assert.equal(h.length, 1, 'the same run is recorded once');
	assert.equal(h[0].item.id, t);
	assert.deepEqual(
		w.sessionItems('s1').map((i) => i.id),
		[t]
	);
});

test('a Work 5 database is set aside untouched and 2.0 starts clean', () => {
	const dir = mkdtempSync(join(tmpdir(), 'falcon-work-aside-'));
	const file = join(dir, 'work.db');
	const old = new DatabaseSync(file);
	old.exec('CREATE TABLE area (id TEXT); PRAGMA user_version=2;');
	old.close();
	const moved = setAsideWork5(file);
	assert.equal(moved, `${file}.before-2`);
	assert.ok(existsSync(moved));
	const w = new Work(file, FRED.id);
	assert.deepEqual(w.views.board().moving, []);
	w.close();
	assert.equal(setAsideWork5(file), null, 'a 2.0 database is left alone');
});
