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

test('registers both tools, the UI operations and the three hooks', async () => {
	const { reg } = await started();
	assert.deepEqual(Object.keys(reg.tools).sort(), ['falcon_work', 'falcon_work_read']);
	assert.deepEqual(Object.keys(reg.actions).sort(), ['do', 'read']);
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
