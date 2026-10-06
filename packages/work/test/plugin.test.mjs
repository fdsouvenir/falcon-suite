// The OpenClaw wiring (spec §10): tools, the brief, captured activity and the end-of-turn nudge.
// Runs the built plugin against a recording stand-in for the plugin API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../dist/index.js';
import { COMMANDS } from '../dist/store/work.js';
import { COMMAND_NAMES } from '../dist/contract.js';
import { classify } from '../dist/plugin/activity.js';
import { resetWork } from '../dist/plugin/runtime.js';
import { humanFromClient } from '../dist/plugin/identity.js';

function load() {
	const reg = { services: [], hooks: {}, tools: {}, actions: {} };
	const api = new Proxy(
		{},
		{
			get(_, key) {
				if (key === 'pluginConfig') return {};
				if (key === 'id') return 'falcon-work';
				if (key === 'registerService') return (s) => reg.services.push(s);
				if (key === 'on') return (name, fn) => (reg.hooks[name] = fn);
				if (key === 'registerTool') return (factory, opts) => (reg.tools[opts.name] = factory);
				if (key === 'registerSessionAction') return (a) => (reg.actions[a.id] = a);
				return () => {};
			}
		}
	);
	plugin.register(api);
	return reg;
}

async function started() {
	resetWork();
	const reg = load();
	const stateDir = mkdtempSync(join(tmpdir(), 'falcon-work-plugin-'));
	for (const s of reg.services) await s.start?.({ stateDir, gatewayEvents: { emit() {} } });
	const call = async (name, params, agentId = 'verl') => {
		const tool = reg.tools[name]({ agentId, sessionKey: 'agent:verl:main' });
		const r = await tool.execute(`call-${Math.random()}`, params);
		return r.details ?? JSON.parse(r.content[0].text);
	};
	const hook = (name, event, ctx = {}) =>
		reg.hooks[name](event, { agentId: 'verl', sessionKey: 'agent:verl:main', ...ctx });
	return { reg, call, hook };
}

test('the contract lists exactly the store commands', () => {
	assert.deepEqual([...COMMAND_NAMES].sort(), COMMANDS.map((c) => c.name).sort());
});

test('read-only tool calls are not work; changes are', () => {
	assert.equal(classify('read', { path: '/x' }), null);
	assert.equal(classify('exec', { command: 'git status && ls -la | grep x' }), null);
	assert.equal(classify('exec', { command: 'rm -rf build' }).kind, 'command');
	assert.equal(classify('exec', { command: 'git commit -m "x"' }).kind, 'commit');
	assert.equal(
		classify('exec', { command: 'clawhub package publish packages/work' }).kind,
		'release'
	);
	assert.equal(classify('write', { path: 'USER.md' }).kind, 'file');
	assert.equal(classify('message', { action: 'send', target: 'discord:1' }).kind, 'message');
	assert.equal(classify('message', { action: 'read' }), null);
	assert.equal(classify('automations', { action: 'list' }), null);
	assert.equal(classify('automations', { action: 'add' }).kind, 'config');
	assert.equal(classify('falcon_work', { command: 'start' }), null);
	assert.equal(classify('write', { path: 'x' }, 'EACCES'), null, 'failed calls changed nothing');
	assert.equal(classify('some_new_tool', {}).kind, 'api', 'unknown tools count as changes');
	assert.equal(
		classify(
			'exec',
			{ script: 'return await falcon_work_read({view:"help"})' },
			undefined,
			'code_mode_exec'
		),
		null,
		'code-mode wrappers are not activity'
	);
});

test('registers the tools, the UI operations and the three hooks', async () => {
	const { reg } = await started();
	assert.deepEqual(Object.keys(reg.tools).sort(), [
		'falcon_work',
		'falcon_work_ask',
		'falcon_work_finding',
		'falcon_work_plan',
		'falcon_work_read',
		'falcon_work_task'
	]);
	assert.deepEqual(Object.keys(reg.actions).sort(), [
		'ask',
		'do',
		'finding',
		'plan',
		'read',
		'task'
	]);
	for (const h of ['before_prompt_build', 'after_tool_call', 'before_agent_finalize'])
		assert.ok(reg.hooks[h], h);
});

test('untracked changes get exactly one nudge; recorded work gets none', async () => {
	const { call, hook } = await started();
	const brief = hook('before_prompt_build', {});
	assert.match(brief.prependSystemContext, /Falcon Work/);
	assert.match(brief.prependContext, /no Task in progress/);

	hook('after_tool_call', { toolName: 'write', params: { path: 'USER.md' }, runId: 'r1' });
	const nudge = hook('before_agent_finalize', {
		runId: 'r1',
		sessionId: 's',
		stopHookActive: false
	});
	assert.equal(nudge.action, 'revise');
	assert.equal(
		hook('before_agent_finalize', { runId: 'r1', sessionId: 's', stopHookActive: false }),
		undefined
	);

	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const t = await call('falcon_work', {
		command: 'create_task',
		input: { title: 'Fix plunge', description: 'd', done_when: 'x', area }
	});
	assert.equal(t.outcome, 'committed');
	assert.equal(
		(await call('falcon_work', { command: 'start', id: t.id, input: { claim: true } })).outcome,
		'committed'
	);
	hook('after_tool_call', {
		toolName: 'exec',
		params: { command: 'git commit -m fix' },
		runId: 'r2'
	});
	assert.equal(
		hook('before_agent_finalize', { runId: 'r2', sessionId: 's', stopHookActive: false }),
		undefined,
		'attached to the in-progress Task'
	);

	const task = await call('falcon_work_read', { view: 'get', id: t.id });
	assert.equal(task.activity.length, 1);
	assert.equal(task.activity[0].kind, 'commit');
	assert.match(hook('before_prompt_build', {}).prependContext, /In progress: Fix plunge/);
});

test('the objectives, Project and Activity pages load through the UI read', async () => {
	const { reg } = await started();
	const act = (payload) =>
		reg.actions.do.handler({ payload, client: { connId: 'c', scopes: ['operator.write'] } });
	const read = (payload) =>
		reg.actions.read.handler({ payload, client: { connId: 'c', scopes: ['operator.read'] } });
	const unwrap = async (p) => {
		const r = await p;
		return r.result ?? r;
	};
	const o = (
		await unwrap(act({ command: 'create_objective', input: { title: 'Grow', statement: 's' } }))
	).id;
	const area = (
		await unwrap(act({ command: 'create_area', input: { title: 'Home', description: 'd' } }))
	).id;
	const p = (
		await unwrap(
			act({ command: 'create_project', input: { title: 'P', outcome: 'o', area, serves: [o] } })
		)
	).id;
	const list = await unwrap(read({ view: 'objectives' }));
	assert.deepEqual(
		list.map((x) => [x.serving.projects[0].tasks_done, x.serving.projects[0].tasks_total]),
		[[0, 0]]
	);
	const page = await unwrap(read({ view: 'project', id: p }));
	assert.equal(page.error, undefined, page.error);
	assert.equal(page.history[0].title, 'P');
	// Long edits must not push the Activity page past what OpenClaw will carry.
	for (let n = 0; n < 30; n++)
		await unwrap(
			act({
				command: 'edit_project',
				id: p,
				input: { outcome: `${n}`.padEnd(12000, 'x'), reason: `round ${n}` }
			})
		);
	const feed = await unwrap(read({ view: 'feed', filters: { feed: 'changes' } }));
	assert.equal(feed.error, undefined, feed.error);
	assert.equal(feed.items[0].detail.reason, 'round 29');
});

test('a retried tool call with the same id does not apply twice', async () => {
	const { reg } = await started();
	const tool = reg.tools.falcon_work({ agentId: 'verl' });
	const params = { command: 'create_area', input: { title: 'Home', description: 'd' } };
	const a = await tool.execute('same-call', params);
	const b = await tool.execute('same-call', params);
	assert.deepEqual(a.details ?? a.content, b.details ?? b.content);
});

test('a reloaded registration uses the same store without its own service starting', async () => {
	const { call } = await started(); // first registration: service started
	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const second = load(); // hot reload: new registration, its service never starts
	const tool = second.tools.falcon_work_read({ agentId: 'verl' });
	const r = await tool.execute('after-reload', { view: 'list', kind: 'area' });
	const out = r.details ?? JSON.parse(r.content[0].text);
	assert.deepEqual(
		out.items.map((a) => a.id),
		[area]
	);
});

test('an updated copy of the code uses its own store on the same data', async () => {
	const { call } = await started();
	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const old = (await import('../dist/plugin/runtime.js')).currentWork();
	// A plugin update loads the new version's modules into the same process.
	const updated = await import(`../dist/plugin/runtime.js?update=${Date.now()}`);
	const fresh = updated.currentWork();
	assert.notEqual(fresh, old, 'the new code must not run the old version’s store');
	assert.deepEqual(
		fresh.reads.list('area', {}).items.map((a) => a.id),
		[area]
	);
	fresh.close();
});

test('a paired browser or token login on the Gateway counts as the Gateway owner', () => {
	assert.deepEqual(humanFromClient({ connect: { role: 'operator' } }), {
		kind: 'human',
		id: 'person:gateway-owner'
	});
	assert.deepEqual(
		humanFromClient({
			connect: { role: 'operator' },
			authenticatedUserProfile: { profileId: 'fred' }
		}),
		{ kind: 'human', id: 'person:fred' }
	);
	assert.equal(humanFromClient({ connect: { role: 'node' } }), null);
	assert.equal(humanFromClient({ internal: { syntheticClient: true } }), null);
	assert.equal(humanFromClient({ internal: { operatorRoleActor: { kind: 'system' } } }), null);
	assert.equal(
		humanFromClient({
			authenticatedUserProfile: { profileId: 'a' },
			internal: { operatorRoleActor: { kind: 'operator', profileId: 'b' } }
		}),
		null
	);
	assert.equal(humanFromClient(undefined), null);
});

test('a Control UI call with operator scopes is the Gateway owner even without a visible connection', async () => {
	const { reg } = await started();
	const r = await reg.actions.do.handler({
		pluginId: 'falcon-work',
		actionId: 'do',
		payload: { command: 'create_area', input: { title: 'Home', description: 'd' } },
		client: { connId: 'c1', scopes: ['operator.write'] }
	});
	const out = r.result ?? r;
	assert.ok(['committed', 'committed_with_warnings'].includes(out.outcome), JSON.stringify(r));
	await assert.rejects(
		reg.actions.read.handler({
			pluginId: 'falcon-work',
			actionId: 'read',
			payload: { view: 'overview' },
			client: { connId: 'c2', scopes: [] }
		}),
		/signed-in person/
	);
});

test('the intent tools: plan a Project, track a Task, ask the person, record a Finding', async () => {
	const { call } = await started();
	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const t = (key, title, depends_on) => ({
		key,
		title,
		description: 'd',
		done_when: 'x',
		...(depends_on ? { depends_on } : {})
	});
	const plan = await call('falcon_work_plan', {
		new_project: { title: 'Plunge', outcome: 'o', area },
		milestones: [
			{
				title: 'M1',
				success_condition: 's',
				tasks: [t('a', 'Sensor'), t('b', 'Controller', ['a'])]
			}
		]
	});
	assert.equal(plan.outcome, 'committed', JSON.stringify(plan));
	const both = await call('falcon_work_plan', {
		project: plan.id,
		new_project: { title: 'x', outcome: 'o', area }
	});
	assert.equal(both.code, 'invalid_input');

	const task = await call('falcon_work_task', {
		action: 'create',
		title: 'Calibrate',
		description: 'd',
		done_when: 'x',
		project: plan.id,
		start: true
	});
	assert.equal(task.started, 'committed', JSON.stringify(task));
	const waited = await call('falcon_work_task', {
		action: 'wait',
		id: task.id,
		waiting_for: 'Fred to read the tub',
		waiting_on: 'person:gateway-owner',
		resume_when: 'He has'
	});
	assert.ok(waited.outcome.startsWith('committed'), JSON.stringify(waited));
	await call('falcon_work_task', { action: 'resume', id: task.id });
	const done = await call('falcon_work_task', {
		action: 'complete',
		id: task.id,
		result: 'Calibrated',
		evidence: [{ ref: 'commit:abc' }]
	});
	assert.ok(done.outcome.startsWith('committed'), JSON.stringify(done));

	const q = await call('falcon_work_ask', {
		kind: 'question',
		prompt: 'How cold?',
		impact: 'Sets the floor',
		hypothesis: '36',
		about: [plan.id]
	});
	assert.equal(q.outcome, 'committed', JSON.stringify(q));
	const dec = await call('falcon_work_ask', {
		kind: 'decision',
		prompt: 'Which sensor?',
		options: [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' }
		],
		recommendation: { option: 'a', rationale: 'r' },
		consequence_of_no_decision: 'c',
		about: [task.id]
	});
	assert.equal(dec.outcome, 'committed', JSON.stringify(dec));
	const asked = await call('falcon_work_read', { view: 'get', id: q.id });
	assert.deepEqual(
		asked.answerable_by,
		['person:gateway-owner'],
		'asks the Gateway owner by default'
	);

	const f = await call('falcon_work_finding', {
		conclusion: 'Stop Core first',
		confidence: 'confirmed',
		evidence: [{ ref: 'notes:2026-09-18' }],
		about: [plan.id]
	});
	assert.equal(f.outcome, 'committed', JSON.stringify(f));
	const bad = await call('falcon_work_finding', {
		conclusion: 'x',
		confidence: 'tentative',
		evidence: [{ ref: 'r' }],
		about: ['nope']
	});
	assert.equal(bad.code, 'invalid_input');
});

test('Code Mode scripts passed as code, and progress cards, are not activity', () => {
	assert.equal(classify('exec', { code: 'const p = await falcon_work_read({view:"get"})' }), null);
	assert.equal(classify('progress_card', { markdown: 'x' }), null);
	assert.equal(classify('falcon_work_task', { action: 'start' }), null);
});
