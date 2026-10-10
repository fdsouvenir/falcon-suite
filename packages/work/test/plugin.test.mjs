// The OpenClaw wiring (spec §10): tools, the brief, outcomes and the record keeper.
// Runs the built plugin against a recording stand-in for the plugin API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../dist/index.js';
import { COMMANDS } from '../dist/store/work.js';
import { COMMAND_NAMES } from '../dist/contract.js';
import { outcome } from '../dist/plugin/outcomes.js';
import { resetWork } from '../dist/plugin/runtime.js';
import { humanFromClient } from '../dist/plugin/identity.js';

function load(runtime) {
	const reg = { services: [], hooks: {}, tools: {}, actions: {}, logs: [] };
	const api = new Proxy(
		{},
		{
			get(_, key) {
				if (key === 'pluginConfig') return {};
				if (key === 'runtime') return runtime;
				if (key === 'config') return runtime?.cfg ?? {};
				if (key === 'logger')
					return { info: (m) => reg.logs.push(m), warn: (m) => reg.logs.push(m) };
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

async function started(runtime) {
	resetWork();
	const reg = load(runtime);
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

const model = (answer) => ({
	decisions: {
		calls: [],
		async evaluate(batch, options) {
			this.calls.push({ batch, options });
			return { status: 'ok', result: { model: 'fake', answers: answer(batch, options) } };
		}
	}
});
const settle = () => new Promise((r) => setTimeout(r, 150));

test('the contract lists exactly the store commands', () => {
	assert.deepEqual([...COMMAND_NAMES].sort(), COMMANDS.map((c) => c.name).sort());
});

test('outcomes are what a turn left outside the chat; reads and unknown calls are not', () => {
	const kind = (tool, params, opts) => outcome(tool, params, opts)?.kind ?? null;
	assert.equal(kind('read', { path: '/x' }), null);
	assert.equal(kind('exec', { command: 'git status && ls -la | grep x' }), null);
	// Claude Code's tools count like OpenClaw's own (the cause of the untracked flood, 2026-10-08).
	assert.equal(
		kind('Bash', {
			command: 'grep -rn -i "falcon\\|hook" ~/.claude/settings.json 2>/dev/null | head -40'
		}),
		null
	);
	assert.equal(kind('Bash', { command: 'cd ~/x; sed -n 130,160p a.mjs; echo ---; ls y' }), null);
	assert.equal(
		kind('Bash', { command: 'd=$(find ~ -maxdepth 4 -type d | head -3); echo "$d"' }),
		null
	);
	assert.equal(kind('Read', { file_path: '/x' }), null);
	assert.equal(kind('Grep', { pattern: 'x' }), null);
	assert.equal(
		kind('Bash', { command: 'npm test 2>&1 | tail -20' }),
		null,
		'test runs are not outcomes'
	);
	assert.equal(kind('some_new_tool', {}), null, 'unknown calls are not outcomes');
	const commit = outcome(
		'Bash',
		{ command: 'git add -A && git commit -qm "feat: timeline"' },
		{ result: '[main 4fdd0ff] feat: timeline' }
	);
	assert.deepEqual(commit, { kind: 'commit', label: 'feat: timeline', ref: '4fdd0ff' });
	assert.equal(kind('exec', { command: 'git push -q' }), 'push');
	assert.equal(kind('exec', { command: 'clawhub package publish packages/work' }), 'release');
	assert.equal(
		kind('exec', {
			command: "ssh building-902 'podman exec c openclaw plugins update falcon-work-preview'"
		}),
		'deploy'
	);
	assert.equal(kind('exec', { command: 'gh issue comment 382 -R x/y -F /tmp/c.md' }), 'message');
	assert.equal(
		kind('exec', { command: 'rm -rf /tmp/scratch' }),
		null,
		'scratch cleanup is not an outcome'
	);
	assert.equal(kind('Edit', { file_path: 'src/a.ts' }), 'file');
	assert.equal(kind('write', { path: 'USER.md' }), 'file');
	assert.equal(kind('message', { action: 'send', target: 'discord:1' }), 'message');
	assert.equal(kind('message', { action: 'read' }), null);
	assert.equal(kind('automations', { action: 'list' }), null);
	assert.equal(kind('automations', { action: 'add' }), 'config');
	assert.equal(kind('falcon_work', { command: 'start' }), null);
	assert.equal(kind('mcp__openclaw__falcon_work_task', { action: 'start' }), null);
	assert.equal(kind('sessions_spawn', { task: 'x' }), null, 'coordination is not an outcome');
	assert.equal(
		kind('write', { path: 'x' }, { error: 'EACCES' }),
		null,
		'failed calls changed nothing'
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
	for (const h of [
		'before_prompt_build',
		'after_tool_call',
		'before_agent_finalize',
		'subagent_spawned'
	])
		assert.ok(reg.hooks[h], h);
});

const finalize = async (hook, runId, reply = 'Done.', ctx = {}) => {
	const r = hook(
		'before_agent_finalize',
		{ runId, sessionId: 's', stopHookActive: false, lastAssistantMessage: reply },
		{ runId, ...ctx }
	);
	await hook('agent_end', { runId, messages: [], success: true }, { runId, ...ctx });
	return r;
};

test("without models, a turn is filed under the session's Task, or waits as unfiled work", async () => {
	const { call, hook } = await started();
	const brief = hook('before_prompt_build', {});
	assert.match(brief.prependSystemContext, /records what each turn changes on its own/);
	assert.doesNotMatch(brief.prependContext, /no Task in progress/, 'no pressure line');

	hook('after_tool_call', { toolName: 'Bash', params: { command: 'grep -rn x .' }, runId: 'r0' });
	assert.equal(await finalize(hook, 'r0'), undefined, 'never asks the agent to redo its reply');
	await settle();
	assert.equal(
		(await call('falcon_work_read', { view: 'timeline' })).entries.length,
		0,
		'reads leave nothing'
	);

	hook('after_tool_call', { toolName: 'write', params: { path: 'USER.md' }, runId: 'r1' });
	await finalize(hook, 'r1');
	await settle();
	const unfiled = await call('falcon_work_read', { view: 'timeline', filters: { unfiled: true } });
	assert.equal(unfiled.entries.length, 1);
	assert.deepEqual(unfiled.entries[0].outcomes, [
		{ kind: 'file', label: 'USER.md', ref: 'USER.md' }
	]);

	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const t = await call('falcon_work_task', {
		action: 'create',
		title: 'Fix plunge',
		description: 'd',
		done_when: 'x',
		area,
		start: true
	});
	assert.equal(t.outcome, 'committed');
	assert.match(
		hook('before_prompt_build', {}).prependContext,
		/This session's work is recorded under: Fix plunge/
	);
	hook('after_tool_call', {
		toolName: 'exec',
		params: { command: 'git commit -m fix' },
		result: '[main abc1234] fix',
		runId: 'r2'
	});
	await finalize(hook, 'r2');
	await settle();
	const task = await call('falcon_work_read', { view: 'get', id: t.id });
	assert.equal(task.timeline.length, 1);
	assert.equal(task.timeline[0].outcomes[0].kind, 'commit');
	assert.equal(task.timeline[0].recorded_by, 'work');

	// Another session does not inherit this session's Task.
	hook(
		'after_tool_call',
		{ toolName: 'write', params: { path: 'other.md' }, runId: 'r3' },
		{ sessionKey: 'agent:verl:other' }
	);
	await finalize(hook, 'r3', 'Done.', { sessionKey: 'agent:verl:other' });
	await settle();
	assert.equal(
		(await call('falcon_work_read', { view: 'timeline', filters: { unfiled: true } })).entries
			.length,
		2
	);
});

test('the record keeper opens a Task for new work and completes it when its done-when is met', async () => {
	const runtime = {
		...model((batch, options) =>
			options.purpose !== 'falcon-work.record'
				? {}
				: batch.questions.done
					? {
							place: { type: 'choice', choice: 'current', probabilities: { current: 0.9 } },
							done: { type: 'boolean', probabilityTrue: 0.95 }
						}
					: {
							place: { type: 'choice', choice: 'new_work', probabilities: { new_work: 0.9 } },
							where: { type: 'choice', choice: 'a1', probabilities: { a1: 0.9 } }
						}
		),
		cfg: { agents: { defaults: { utilityModel: 'openai/gpt-5.6-luna' } } },
		llm: {
			prompts: [],
			async complete(p) {
				this.prompts.push(p);
				const text = p.messages[0].content;
				return {
					text: JSON.stringify({
						summary: 'Enrolled the Building in NetBird.',
						...(text.includes('"task"')
							? {
									task: {
										title: 'Protected NetBird enrollment',
										description: 'Enroll new Buildings.',
										done_when: 'A new Building enrolls itself.'
									}
								}
							: {}),
						...(text.includes('"result"') ? { result: 'Buildings now enroll themselves.' } : {})
					})
				};
			}
		}
	};
	const { reg, call, hook } = await started(runtime);
	// The writer uses the utility model, never the agent's main one.
	const api = reg;
	await call('falcon_work', {
		command: 'create_area',
		input: { title: 'Fredbot Platform', description: 'd' }
	});
	hook(
		'before_prompt_build',
		{
			prompt: 'wire NetBird enrollment',
			currentUserMessage: 'wire NetBird enrollment',
			messages: []
		},
		{ runId: 'n1', trigger: 'user' }
	);
	hook('after_tool_call', {
		toolName: 'Bash',
		params: { command: 'git commit -m "NetBird enrollment"' },
		result: '[main 16593e1] NetBird enrollment',
		runId: 'n1'
	});
	await finalize(hook, 'n1');
	await settle();
	const tasks = (await call('falcon_work_read', { view: 'list', kind: 'task' })).items;
	assert.equal(tasks.length, 1);
	const t = await call('falcon_work_read', { view: 'get', id: tasks[0].id });
	assert.equal(t.definition.title, 'Protected NetBird enrollment');
	assert.equal(t.status, 'in_progress');
	assert.equal(t.recorded_by_work, true);
	assert.equal(t.timeline[0].summary, 'Enrolled the Building in NetBird.');
	assert.equal(t.timeline[0].outcomes[0].ref, '16593e1');
	assert.equal(runtime.llm.prompts[0].purpose, 'falcon-work.record');
	assert.equal(
		runtime.llm.prompts[0].model,
		'openai/gpt-5.6-luna',
		'the utility model, not the main one'
	);

	hook('after_tool_call', {
		toolName: 'Bash',
		params: { command: 'git commit -m "enrollment test"' },
		runId: 'n2'
	});
	await finalize(hook, 'n2');
	await settle();
	const done = await call('falcon_work_read', { view: 'get', id: t.id });
	assert.equal(done.status, 'completed');
	assert.equal(done.timeline.length, 2);
	assert.equal(done.timeline[0].completed, true, 'the turn that finished it says so');
	assert.equal(done.timeline[1].completed, false);
	assert.equal(done.timeline[0].task.place, 'Fredbot Platform');
	assert.equal(done.origin.session, 'agent:verl:main', 'where Work opened it');

	// A turn that opens a Task and already meets its done-when completes it there and then.
	runtime.decisions.evaluate = async (batch, options) => ({
		status: 'ok',
		result: {
			answers:
				options.purpose === 'falcon-work.record-done'
					? { done: { type: 'boolean', probabilityTrue: 0.9 } }
					: {
							place: { type: 'choice', choice: 'new_work', probabilities: { new_work: 0.9 } },
							where: { type: 'choice', choice: 'a1', probabilities: { a1: 0.9 } }
						}
		}
	});
	hook(
		'before_prompt_build',
		{ prompt: 'x', currentUserMessage: 'write the list', messages: [] },
		{ runId: 'n3', trigger: 'user', sessionKey: 'agent:verl:other' }
	);
	hook(
		'after_tool_call',
		{ toolName: 'Write', params: { file_path: 'list.md' }, runId: 'n3' },
		{ sessionKey: 'agent:verl:other' }
	);
	await finalize(hook, 'n3', 'Wrote the list.', { sessionKey: 'agent:verl:other' });
	const all = (
		await call('falcon_work_read', { view: 'list', kind: 'task', filters: { status: 'completed' } })
	).items;
	assert.equal(all.length, 2, 'opened and completed in one turn');
	void api;
});

test('new work goes into a Project only when clearly so, else the likeliest Area', async () => {
	const { placeFor } = await import('../dist/plugin/keeper.js');
	const places = [
		{ key: 'a1', kind: 'area' },
		{ key: 'p2', kind: 'project' },
		{ key: 'a3', kind: 'area' }
	];
	assert.equal(placeFor(places, { p2: 0.7, a1: 0.2 }).key, 'p2');
	assert.equal(
		placeFor(places, { p2: 0.5, a3: 0.4 }).key,
		'a3',
		'a weak Project gives way to its Area'
	);
	assert.equal(placeFor(places, { a3: 0.39, a1: 0.1, none: 0.5 }).key, 'a3', 'the beach-day case');
	assert.equal(placeFor(places, { a3: 0.2, none: 0.8 }), null);
});

test('a subagent works under the Task of the session that spawned it', async () => {
	const { call, hook } = await started();
	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const t = await call('falcon_work_task', {
		action: 'create',
		title: 'Provisioning',
		description: 'd',
		done_when: 'x',
		area,
		start: true
	});
	hook(
		'subagent_spawned',
		{ childSessionKey: 'agent:verl:sub1', agentId: 'verl', mode: 'run', threadRequested: false },
		{ childSessionKey: 'agent:verl:sub1', requesterSessionKey: 'agent:verl:main' }
	);
	hook(
		'after_tool_call',
		{ toolName: 'Edit', params: { file_path: 'src/netbird.ts' }, runId: 's1' },
		{ sessionKey: 'agent:verl:sub1' }
	);
	await finalize(hook, 's1', 'Done.', { sessionKey: 'agent:verl:sub1' });
	await settle();
	const task = await call('falcon_work_read', { view: 'get', id: t.id });
	assert.equal(task.timeline.length, 1);
	assert.equal(task.timeline[0].session, 'agent:verl:sub1');
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
	const feed = await unwrap(read({ view: 'feed', filters: { feed: 'all' } }));
	assert.equal(feed.error, undefined, feed.error);
	assert.deepEqual(feed.items, [], 'Activity is timelines, not command history');
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

test('Code Mode scripts passed as code, and progress cards, are not outcomes', () => {
	assert.equal(outcome('exec', { code: 'const p = await falcon_work_read({view:"get"})' }), null);
	assert.equal(outcome('progress_card', { markdown: 'x' }), null);
	assert.equal(outcome('falcon_work_task', { action: 'start' }), null);
});

test('several Questions in one call, holding the Tasks they block on the person asked', async () => {
	const { call } = await started();
	const area = (
		await call('falcon_work', {
			command: 'create_area',
			input: { title: 'Home', description: 'd' }
		})
	).id;
	const task = (
		await call('falcon_work_task', {
			action: 'create',
			title: 'Define sale goals',
			description: 'd',
			done_when: 'x',
			area,
			start: true
		})
	).id;
	const r = await call('falcon_work_ask', {
		kind: 'question',
		questions: [
			{ prompt: 'Where is the house?', impact: 'Sets the market' },
			{ prompt: 'List or close by spring?', impact: 'Sets the dates', hypothesis: 'List' }
		],
		holds: [task]
	});
	assert.equal(r.outcome, 'committed', JSON.stringify(r));
	assert.equal(r.questions.length, 2);
	assert.equal(r.held[0].outcome, 'committed');
	const t = await call('falcon_work_read', { view: 'get', id: task });
	assert.equal(t.status, 'waiting');
	assert.equal(t.waiting_on_ref, 'person:gateway-owner');
	const q = await call('falcon_work_read', { view: 'get', id: r.questions[1] });
	assert.deepEqual(
		q.targets.map((x) => x.id),
		[task],
		'each Question is about the Task it holds'
	);

	const noWho = await call('falcon_work_task', {
		action: 'wait',
		id: task,
		waiting_for: 'x',
		resume_when: 'y'
	});
	assert.equal(noWho.code, 'invalid_input', 'a wait always says who or what');
});

test('Code Mode scripts are not outcomes however they start', () => {
	for (const command of [
		"const ts = await catalog.search('memory_search'); text(await ts[0]({}))",
		'text(await falcon_work_read({view:"brief"}))',
		'for (const id of ids) text(await falcon_work_read({view:"get", id}))'
	])
		assert.equal(outcome('exec', { command }), null, command);
	assert.equal(outcome('exec', { command: 'for f in *.log; do rm "$f"; done' }).kind, 'change');
});

test('the text check behind the fallback reminder recognises asks, including requests without a question mark', async () => {
	const { asksThePerson } = await import('../dist/plugin/asks.js');
	assert.ok(
		asksThePerson(
			'To unlock the next useful work, **what city is the house in?** Include any deadline.'
		)
	);
	assert.ok(asksThePerson('Send me:\n1. **A photo of the label**\n2. **What is going wrong**.'));
	assert.ok(!asksThePerson('Done. The plan is saved in Falcon Work with 8 Milestones.'));
	assert.ok(!asksThePerson('Run `ls -la?` to check.\n\nAll set.'));
});

/** A stand-in decision model: answers come from a function of the request. */
const turn = async (hook, runId, message, reply, ctx = {}) => {
	hook(
		'before_prompt_build',
		{ prompt: message, currentUserMessage: message, messages: [] },
		{ runId, trigger: 'user', ...ctx }
	);
	await settle();
	hook(
		'before_agent_finalize',
		{ runId, sessionId: 's', stopHookActive: false, lastAssistantMessage: reply },
		{ runId, ...ctx }
	);
	await settle();
};

test('gate left_waiting: what a reply needs from the person becomes a Question; other turns do not', async () => {
	const runtime = model((batch) =>
		batch.questions.left_waiting
			? {
					left_waiting: {
						type: 'choice',
						choice: 'needs_answer',
						probabilities: { needs_answer: 0.9, nothing: 0.1 }
					},
					work_request: { type: 'choice', choice: 'track', probabilities: { track: 0.8 } },
					plan_in_chat: { type: 'boolean', probabilityTrue: 0.1 },
					promise: { type: 'boolean', probabilityTrue: 0.05 },
					...Object.fromEntries(
						Object.entries(batch.state.pieces).map(([id, text]) => [
							id,
							{
								type: 'boolean',
								probabilityTrue: /Send me|label|going wrong/.test(text) ? 0.95 : 0.05
							}
						])
					)
				}
			: { message_kind: { type: 'choice', choice: 'chat', probabilities: { chat: 0.9 } } }
	);
	const { call, hook, reg } = await started(runtime);
	await turn(
		hook,
		'g1',
		'our chiller is old, repair or replace?',
		'Diagnose first.\n\nSend me:\n- A photo of the model label\n- What is going wrong'
	);
	let qs = (await call('falcon_work_read', { view: 'list', kind: 'question' })).items;
	assert.equal(qs.length, 1, JSON.stringify(reg.logs));
	const q = await call('falcon_work_read', { view: 'get', id: qs[0].id });
	assert.match(q.prompt, /Send me:\nA photo of the model label\nWhat is going wrong/);
	assert.match(q.impact, /Asked in chat/);
	// One batch per event: the person's message, then the end of the turn.
	assert.deepEqual(
		runtime.decisions.calls.map((c) => c.options.purpose),
		['falcon-work.message', 'falcon-work.turn']
	);
	const turnBatch = runtime.decisions.calls[1].batch;
	assert.ok(
		turnBatch.questions.left_waiting && turnBatch.questions.promise && turnBatch.questions.p1
	);
	assert.equal(
		runtime.decisions.calls[1].batch.state.request,
		'our chiller is old, repair or replace?'
	);
	// Every answer is logged, with what it acted on.
	const { readFileSync } = await import('node:fs');
	const dir = (await import('../dist/plugin/runtime.js')).dataDir();
	const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
	const turnLog = lines.find((l) => l.event === 'turn');
	assert.equal(turnLog.answers.work_request.choice, 'track');
	assert.equal(turnLog.answers.promise, 0.05);
	assert.ok(turnLog.acted[0].startsWith('captured '));
	assert.ok(lines.some((l) => l.event === 'message' && l.answers.message_kind.choice === 'chat'));

	// The next brief tells the agent what was captured.
	const brief = hook(
		'before_prompt_build',
		{ prompt: 'thanks', messages: [] },
		{ runId: 'g1b', trigger: 'heartbeat' }
	);
	assert.match(brief.prependContext, /captured what your last reply asked/);

	// Not from the person: heartbeats and messages from other sessions are never captured.
	await turn(hook, 'g2', '[OpenClaw heartbeat poll]', 'Send me the logs?');
	await turn(hook, 'g3', 'status?', 'Send me the logs?', {
		inputProvenance: { kind: 'inter_session' }
	});
	qs = (await call('falcon_work_read', { view: 'list', kind: 'question' })).items;
	assert.equal(qs.length, 1);
});

test('the captured Question text is the asking sentences, even mid-paragraph', async () => {
	const { askingPart } = await import('../dist/plugin/gates.js');
	assert.equal(
		askingPart(
			"For 120 gallons at 38°F, don't upsize just because it slowed down.\n\n**One important question: is it indoors, in a garage, or outdoors?** The current standard 1 HP is not outdoor-rated."
		),
		'One important question: is it indoors, in a garage, or outdoors?'
	);
	assert.equal(
		askingPart(
			'Diagnose first.\n\nSend me:\n- A photo of the label\n- What is going wrong\n\nThen I can compare.'
		),
		'Send me:\nA photo of the label\nWhat is going wrong'
	);
});

test('the end-of-turn battery asks whether an ask is already open, in shadow', async () => {
	const { turnBattery } = await import('../dist/plugin/gates.js');
	const none = turnBattery({ request: 'r', reply: 'Which city?', task: null, tasks: [] });
	assert.equal(none.batch.questions.already_open, undefined, 'only asked when something is open');
	const b = turnBattery({
		request: 'r',
		reply: 'Which city is the house in?',
		task: null,
		tasks: [],
		open: [{ id: 'q-123', prompt: 'What city is the house in?' }]
	});
	assert.deepEqual(Object.keys(b.batch.questions.already_open.criteria), ['o1', 'none']);
	assert.equal(b.batch.state.open_questions.o1, 'What city is the house in?');
	assert.deepEqual(b.openIds, [['o1', 'q-123']]);
});

test('gate left_waiting below its threshold, or nothing waiting, records nothing', async () => {
	const runtime = model(() => ({
		left_waiting: {
			type: 'choice',
			choice: 'needs_answer',
			probabilities: { needs_answer: 0.4, nothing: 0.35 }
		}
	}));
	const { call, hook } = await started(runtime);
	await turn(hook, 'g4', 'hi', 'Hello! How did the plunge feel?');
	assert.equal(
		(await call('falcon_work_read', { view: 'list', kind: 'question' })).items.length,
		0
	);
});

test('without a decision model, an ask becomes a reminder in the next brief, not a Question', async () => {
	const { call, hook } = await started(undefined);
	await turn(hook, 'g5', 'chiller?', 'Send me a photo of the label?');
	assert.equal(
		(await call('falcon_work_read', { view: 'list', kind: 'question' })).items.length,
		0
	);
	const brief = hook(
		'before_prompt_build',
		{ prompt: 'next', currentUserMessage: 'next', messages: [] },
		{ runId: 'g5b', trigger: 'user' }
	);
	assert.match(brief.prependContext, /asked the person for something that is not in Falcon Work/);
});

test('gate answers_open_item: a chat reply answers the open Question and decides the open Decision', async () => {
	const runtime = model((batch) => {
		const out = {};
		for (const [id, q] of Object.entries(batch.questions))
			out[id] =
				q.type === 'boolean'
					? {
							type: 'boolean',
							probabilityTrue: batch.state.open_items[id].prompt.includes('city') ? 0.95 : 0.1
						}
					: {
							type: 'choice',
							choice: 'apply',
							probabilities: { apply: 0.9, wait: 0.05, not_decided: 0.05 }
						};
		return out;
	});
	const { call, hook } = await started(runtime);
	const q = await call('falcon_work_ask', {
		kind: 'question',
		questions: [
			{ prompt: 'What city is the house in?', impact: 'Market' },
			{ prompt: 'What budget?', impact: 'Scope' }
		]
	});
	const d = await call('falcon_work_ask', {
		kind: 'decision',
		prompt: 'Apply --clear-tools?',
		options: [
			{ id: 'apply', label: 'Apply' },
			{ id: 'wait', label: 'Wait' }
		],
		recommendation: { option: 'apply', rationale: 'r' },
		consequence_of_no_decision: 'c'
	});
	hook(
		'before_prompt_build',
		{
			prompt: 'Chicago. and yes apply it',
			currentUserMessage: 'Chicago. and yes apply it',
			messages: []
		},
		{ runId: 'a1', trigger: 'user' }
	);
	await settle();
	const [city, budget] = await Promise.all(
		q.questions.map((id) => call('falcon_work_read', { view: 'get', id }))
	);
	assert.equal(city.status, 'answered', JSON.stringify(city));
	assert.match(city.answers[0].text, /Chicago/);
	assert.equal(budget.status, 'open');
	const dec = await call('falcon_work_read', { view: 'get', id: d.id });
	assert.equal(dec.status, 'decided');
	assert.equal(dec.chosen_option, 'apply');
	assert.equal(runtime.decisions.calls[0].options.purpose, 'falcon-work.message');
});
