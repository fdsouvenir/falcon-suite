// The clerk (spec §3): Jev judges, code decides, the writer writes, Jev checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Work } from '../dist/store/work.js';
import { CLERK } from '../dist/store/types.js';
import { Clerk } from '../dist/clerk/clerk.js';
import { decideTurn } from '../dist/clerk/decide.js';

const OWNER = 'person:gateway-owner';
const noul = (p) => ({ type: 'boolean', probabilityTrue: p });

/** A fake decision model: answers by question key, with a default for the rest. */
function jev(byKey, fallback = 0.05) {
	const calls = [];
	return {
		calls,
		evaluate: async (batch) => {
			calls.push(batch);
			const answers = {};
			for (const [k, q] of Object.entries(batch.questions)) {
				const v = typeof byKey === 'function' ? byKey(k, batch) : byKey[k];
				if (q.type === 'choice')
					answers[k] = v ?? {
						type: 'choice',
						choice: Object.keys(q.criteria)[0],
						probabilities: {}
					};
				else answers[k] = noul(v ?? fallback);
			}
			return { status: 'ok', result: { answers } };
		}
	};
}

function setup({ decisions, complete, transcript = [] } = {}) {
	const w = new Work(':memory:', OWNER);
	const events = { changed: 0, logs: [] };
	const clerk = new Clerk({
		work: w,
		decisions: () => decisions,
		complete,
		sessions: () => [{ sessionKey: 'agent:william:dashboard:s1', updatedAt: Date.now() }],
		read: async () => transcript,
		agents: () => ['william'],
		log: (l) => events.logs.push(l),
		changed: () => events.changed++
	});
	return { w, clerk, events };
}

const turn = (over = {}) => ({
	agentId: 'william',
	session: 'agent:william:dashboard:s1',
	run: `run-${Math.random()}`,
	request: 'continue the importer',
	reply:
		'Parsing is done. Two decisions remain on the import step. Should the old importer keep running during cutover?',
	outcomes: [{ kind: 'commit', label: 'importer: new parser', ref: 'abc123' }],
	...over
});

test('decision table: a turn about an open item is filed there with a status line from the reply', () => {
	const a = decideTurn({
		answers: {
			work_asked: 0.9,
			work_reported: 0.8,
			any_item: 0.95,
			'about.c1': 0.9,
			'stands.p1': 0.85,
			'stands.p2': 0.2
		},
		candidates: [{ slot: 'c1', id: 'T1', kind: 'task' }],
		pieces: ['Parsing is done.', 'Want me to continue?'],
		open: [],
		outcomes: 1,
		automationJob: null
	});
	assert.deepEqual(
		a.file.map((f) => f.id),
		['T1']
	);
	assert.equal(a.statusLine, 'Parsing is done.');
	assert.deepEqual(a.writer, []);
});

test('decision table: new work and unsettled answers go to the writer; chat goes nowhere', () => {
	const fresh = decideTurn({
		answers: { work_asked: 0.95, work_reported: 0.1 },
		candidates: [],
		pieces: [],
		open: [],
		outcomes: 0,
		automationJob: null
	});
	assert.ok(fresh.writer.includes('new work'));
	const chat = decideTurn({
		answers: { work_asked: 0.05, work_reported: 0.05 },
		candidates: [],
		pieces: [],
		open: [],
		outcomes: 0,
		automationJob: null
	});
	assert.equal(chat.chat, true);
	assert.deepEqual(chat.writer, []);
	const unsure = decideTurn({
		answers: { work_asked: 0.5, work_reported: 0.1 },
		candidates: [],
		pieces: [],
		open: [],
		outcomes: 0,
		automationJob: null
	});
	assert.ok(unsure.writer.includes('unsettled'));
});

test('decision table: Needs you is raised only for work that is an item, and never twice', () => {
	const base = {
		candidates: [{ slot: 'c1', id: 'T1', kind: 'task' }],
		pieces: ['Keep the old importer running?'],
		outcomes: 0,
		automationJob: null
	};
	const raised = decideTurn({
		...base,
		open: [],
		answers: { work_asked: 0.9, any_item: 0.9, 'about.c1': 0.9, needs_person: 0.9, 'asks.p1': 0.9 }
	});
	assert.equal(raised.raise, 'Keep the old importer running?');
	const repeat = decideTurn({
		...base,
		open: [{ slot: 'q1', id: 'Q1' }],
		answers: {
			work_asked: 0.9,
			any_item: 0.9,
			'about.c1': 0.9,
			needs_person: 0.9,
			'asks.p1': 0.9,
			'repeats.q1': 0.95
		}
	});
	assert.equal(repeat.raise, null);
	assert.equal(repeat.repeats, 'Q1');
	const loose = decideTurn({
		candidates: [],
		pieces: ['What is this for?'],
		open: [],
		outcomes: 0,
		automationJob: null,
		answers: { work_asked: 0.1, work_reported: 0.1, needs_person: 0.9, 'asks.p1': 0.9 }
	});
	assert.equal(loose.raise, null, 'a question in chat with no work behind it is not raised');
});

test('judging a turn files it, sets the status line, raises the question and waits the Task on the person', async () => {
	const decisions = jev(
		(k) =>
			({
				work_asked: 0.9,
				work_reported: 0.8,
				any_item: 0.9,
				'about.c1': 0.92,
				needs_person: 0.85,
				'stands.p1': 0.9,
				'asks.p3': 0.9
			})[k]
	);
	const { w, clerk, events } = setup({ decisions });
	const t = w.do(
		{
			command: 'create_task',
			input: {
				title: 'Catalog importer',
				description: 'd',
				done_when: 'New importer live',
				agent: 'agent:william'
			}
		},
		CLERK
	).id;
	w.do({ command: 'start', id: t, input: {} }, CLERK);
	w.linkSession(t, 'task', 'agent:william:dashboard:s1');
	const actions = await clerk.judgeTurn(turn());
	assert.deepEqual(
		actions.file.map((f) => f.id),
		[t]
	);
	const task = w.views.task(t);
	assert.equal(task.status_line, 'Parsing is done.');
	assert.equal(task.status, 'waiting');
	const n = w.views.needsYou();
	assert.equal(n.length, 1);
	assert.equal(n[0].prompt, 'Should the old importer keep running during cutover?');
	assert.equal(n[0].session, 'agent:william:dashboard:s1');
	assert.equal(w.views.happened(null)[0].summary, 'Parsing is done.');
	assert.ok(events.changed > 0);
	// The batch carries the candidate by name, never its id.
	assert.equal(decisions.calls[0].state.candidates.c1.title, 'Catalog importer');
	assert.doesNotMatch(JSON.stringify(decisions.calls[0].state), new RegExp(t));
});

test('without a decision model the session is marked for the writer instead', async () => {
	const { clerk } = setup({ decisions: undefined });
	await clerk.judgeTurn(turn());
	assert.deepEqual(
		clerk.marked().map((m) => m.reasons),
		[['no decision model']]
	);
});

test('a failed decision-model call is an error, not a "no": the session goes to the writer', async () => {
	const { clerk } = setup({
		decisions: {
			evaluate: async () => {
				throw new Error('timeout');
			}
		}
	});
	await clerk.judgeTurn(turn());
	assert.equal(clerk.marked().length, 1);
});

test('the writer creates new work, Jev turns duplicates into updates, and the checkpoint moves', async () => {
	const transcript = [
		{
			seq: 1,
			role: 'user',
			text: 'install gcloud with machine auth from the vault',
			at: '2026-11-02T10:00:00Z'
		},
		{
			seq: 2,
			role: 'assistant',
			text: 'Installed gcloud 512 and authenticated as the operator service account.',
			at: '2026-11-02T10:05:00Z'
		}
	];
	const prompts = [];
	const complete = async (agentId, system, message) => {
		prompts.push({ agentId, system, message });
		return JSON.stringify({
			edits: [
				{
					op: 'create_task',
					key: 't1',
					title: 'Install gcloud with machine auth',
					description: 'Install and authenticate gcloud',
					done_when: 'gcloud works with the machine account'
				},
				{
					op: 'create_task',
					key: 't2',
					title: 'Catalog importer again',
					description: 'dup',
					done_when: 'x'
				},
				{
					op: 'complete',
					task: 't1',
					result: 'gcloud 512 installed and authenticated as the operator service account.'
				},
				{
					op: 'entry',
					item: 't1',
					summary: 'Installed gcloud and signed it in with the machine account.'
				}
			]
		});
	};
	// Jev: proposal n2 is the same as the open item; the completion is confirmed.
	const decisions = jev((k) => (k === 'same.n2.o1' ? 0.95 : k === 'done' ? 0.9 : 0.05));
	const { w, clerk } = setup({ decisions, complete, transcript });
	const existing = w.do(
		{
			command: 'create_task',
			input: { title: 'Catalog importer', description: 'd', done_when: 'x', agent: 'agent:william' }
		},
		CLERK
	).id;
	w.do({ command: 'start', id: existing, input: {} }, CLERK);
	clerk.mark('william', 'agent:william:dashboard:s1', ['new work']);
	const applied = await clerk.writerPass('william', 'agent:william:dashboard:s1');
	assert.ok(applied >= 3, `applied ${applied}`);
	assert.match(prompts[0].message, /install gcloud/);
	const found = w.views.search('gcloud');
	assert.equal(found.length, 1);
	assert.equal(found[0].state, 'completed');
	assert.equal(w.views.search('again').length, 0, 'the duplicate became an update, not a new Task');
	assert.deepEqual(clerk.marked(), []);
	assert.equal(
		await clerk.writerPass('william', 'agent:william:dashboard:s1', true),
		0,
		'nothing new since the checkpoint'
	);
});

test('the person answering in chat clears Needs you', async () => {
	const decisions = jev((k) => (k.startsWith('answers.') ? 0.92 : 0.05));
	const { w, clerk } = setup({ decisions });
	w.do(
		{
			command: 'raise_question',
			input: { prompt: 'Resume or keep paused?', impact: 'i', answerable_by: [OWNER] }
		},
		CLERK
	);
	await clerk.checkAnswers('william', 'agent:william:dashboard:s1', 'resume it', 'run-1');
	assert.equal(w.views.needsYou().length, 0);
});

test('catch-up reads past sessions newest first and records progress', async () => {
	const transcript = [
		{ seq: 1, role: 'user', text: 'fix the importer', at: '2026-11-02T10:00:00Z' },
		{
			seq: 2,
			role: 'assistant',
			text: 'Fixed the importer and pushed the change.',
			at: '2026-11-02T10:05:00Z'
		}
	];
	const decisions = jev({ work_asked: 0.9, work_reported: 0.9 });
	const complete = async () =>
		JSON.stringify({
			edits: [
				{
					op: 'create_task',
					title: 'Fix the importer',
					description: 'd',
					done_when: 'Importer fixed'
				}
			]
		});
	const { w, clerk } = setup({ decisions, complete, transcript });
	await clerk.catchUp(14);
	const progress = JSON.parse(w.meta('catchup'));
	assert.deepEqual([progress.read, progress.total, progress.done], [1, 1, true]);
	assert.equal(w.views.search('importer').length, 1);
	assert.equal(w.views.home().catching_up.done, true);
});
