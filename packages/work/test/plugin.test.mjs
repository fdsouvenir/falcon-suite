// The OpenClaw wiring (spec §5, §7): tools, hooks, the service and the UI reads.
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
	for (const s of reg.services) s.stop?.();
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

test('Code Mode scripts passed as code, and progress cards, are not outcomes', () => {
	assert.equal(outcome('exec', { code: 'const p = await falcon_work_read({view:"get"})' }), null);
	assert.equal(outcome('progress_card', { markdown: 'x' }), null);
	assert.equal(outcome('falcon_work_task', { action: 'start' }), null);
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

test('registers the tools (with the Job tool), the UI operations and the observing hooks', async () => {
	const { reg } = await started();
	assert.deepEqual(Object.keys(reg.tools).sort(), [
		'falcon_work',
		'falcon_work_ask',
		'falcon_work_finding',
		'falcon_work_job',
		'falcon_work_plan',
		'falcon_work_read',
		'falcon_work_task'
	]);
	assert.deepEqual(Object.keys(reg.actions).sort(), [
		'ask',
		'do',
		'finding',
		'job',
		'plan',
		'read',
		'task'
	]);
	for (const h of [
		'before_prompt_build',
		'after_tool_call',
		'agent_end',
		'before_compaction',
		'session_end'
	])
		assert.ok(reg.hooks[h], h);
});

test("the prompt hook only observes: Work adds nothing to the agent's prompt", async () => {
	const { hook } = await started();
	const r = hook(
		'before_prompt_build',
		{ prompt: 'hello', currentUserMessage: 'hello' },
		{ runId: 'r0', trigger: 'user' }
	);
	assert.equal(r, undefined);
});

test('the end of a turn makes no model calls in the hook and never changes the answer', async () => {
	const calls = [];
	const runtime = {
		decisions: { evaluate: async (b) => (calls.push(b), { status: 'ok', result: { answers: {} } }) }
	};
	const { hook } = await started(runtime);
	const event = { runId: 'r1', success: true, messages: [{ role: 'assistant', content: 'Done.' }] };
	const r = hook('agent_end', event, { runId: 'r1' });
	assert.equal(r, undefined, 'synchronous and silent');
	assert.equal(calls.length, 0, 'no model call inside the hook');
	assert.deepEqual(event.messages, [{ role: 'assistant', content: 'Done.' }]);
	await settle();
	assert.equal(calls.length, 1, 'the clerk judged the turn afterwards');
});

test('the intent tools: plan a Project, track a Task, keep a Job, ask the person, record a Finding', async () => {
	const { call } = await started();
	const p = await call('falcon_work_plan', {
		new_project: { title: 'Catalog import refactor', outcome: 'New importer live' },
		milestones: [
			{
				title: 'Parse',
				success_condition: 'Parser done',
				tasks: [{ title: 'Rewrite parser', description: 'd', done_when: 'x' }]
			}
		]
	});
	assert.equal(p.outcome, 'committed');
	const j = await call('falcon_work_job', {
		action: 'create',
		title: 'Support inbox',
		instructions: 'Draft a reply to everything',
		automations: [{ id: 'cron-1' }]
	});
	assert.equal(j.outcome, 'committed');
	const t = await call('falcon_work_task', {
		action: 'create',
		title: 'Reply to Dana',
		description: 'd',
		done_when: 'Reply sent',
		job: j.id,
		start: true
	});
	assert.equal(t.started, 'committed');
	const q = await call('falcon_work_ask', {
		kind: 'question',
		prompt: 'Refund over $200: approve?',
		impact: 'i',
		about: [t.id],
		holds: [t.id]
	});
	assert.equal(q.outcome, 'committed');
	const f = await call('falcon_work_finding', {
		conclusion: 'Vendor feed drops SKUs',
		confidence: 'supported',
		evidence: [{ ref: 'x' }],
		about: [p.id]
	});
	assert.equal(f.outcome, 'committed');
	const home = await call('falcon_work_read', { view: 'home' });
	assert.equal(home.needs_you[0].prompt, 'Refund over $200: approve?');
	assert.equal(
		home.needs_you[0].session,
		'agent:verl:main',
		'the question links back to its conversation'
	);
	const job = await call('falcon_work_read', { view: 'job', id: j.id });
	assert.equal(job.open_tasks[0].status, 'waiting');
	const found = await call('falcon_work_read', { view: 'search', text: 'refactor' });
	assert.equal(found.results[0].id, p.id);
});

test('a retried tool call with the same id does not apply twice', async () => {
	const { reg } = await started();
	const tool = reg.tools.falcon_work({ agentId: 'verl' });
	const params = { command: 'create_job', input: { title: 'Inbox', instructions: 'd' } };
	const a = await tool.execute('same-call', params);
	const b = await tool.execute('same-call', params);
	assert.deepEqual(a.details ?? a.content, b.details ?? b.content);
});

test('a reloaded registration uses the same store without its own service starting', async () => {
	const { call } = await started();
	const job = (
		await call('falcon_work', {
			command: 'create_job',
			input: { title: 'Inbox', instructions: 'd' }
		})
	).id;
	const second = load();
	const tool = second.tools.falcon_work_read({ agentId: 'verl' });
	const r = await tool.execute('after-reload', { view: 'job', id: job });
	const out = r.details ?? JSON.parse(r.content[0].text);
	assert.equal(out.id, job);
});

test('an updated copy of the code uses its own store on the same data', async () => {
	const { call } = await started();
	const job = (
		await call('falcon_work', {
			command: 'create_job',
			input: { title: 'Inbox', instructions: 'd' }
		})
	).id;
	const old = (await import('../dist/plugin/runtime.js')).currentWork();
	const updated = await import(`../dist/plugin/runtime.js?update=${Date.now()}`);
	const fresh = updated.currentWork();
	assert.notEqual(fresh, old, 'the new code must not run the old version’s store');
	assert.equal(fresh.views.job(job).id, job);
	fresh.close();
});

test('a Control UI call with operator scopes is the Gateway owner; without them it is refused', async () => {
	const { reg } = await started();
	const r = await reg.actions.do.handler({
		pluginId: 'falcon-work',
		actionId: 'do',
		payload: { command: 'create_job', input: { title: 'Inbox', instructions: 'd' } },
		client: { connId: 'c1', scopes: ['operator.write'] }
	});
	const out = r.result ?? r;
	assert.ok(['committed', 'committed_with_warnings'].includes(out.outcome), JSON.stringify(r));
	await assert.rejects(
		reg.actions.read.handler({
			pluginId: 'falcon-work',
			actionId: 'read',
			payload: { view: 'home' },
			client: { connId: 'c2', scopes: [] }
		}),
		/signed-in person/
	);
});

// A large record (2026-11-04: 297 open asks made Home fail as "Feature output must be bounded
// JSON"). Every read goes through the real tool, which refuses answers past the Gateway's limits.
test('every view loads however much work there is, and paging reaches every item once', async () => {
	const { call } = await started();
	const w = (await import('../dist/plugin/runtime.js')).currentWork();
	const AGENT = { kind: 'agent', id: 'agent:verl' };
	const ok = (env) => {
		const r = w.do(env, AGENT);
		assert.ok(r.outcome.startsWith('committed'), JSON.stringify(r));
		return r.id;
	};
	const long = (n) => `${'A long and specific question about the work. '.repeat(12)}#${n}`;
	const tasks = [];
	for (let i = 0; i < 400; i++) {
		const id = ok({
			command: 'create_task',
			input: {
				title: `Task ${i} ${'with a long title '.repeat(4)}`,
				description: 'd',
				done_when: 'x'
			}
		});
		ok({ command: 'start', id, input: { claim: true } });
		if (i % 4 === 1)
			ok({
				command: 'wait',
				id,
				input: {
					waiting_for: 'A reply',
					waiting_on: { kind: 'external', ref: 'vendor' },
					resume_when: 'Replied'
				}
			});
		if (i % 4 === 2)
			ok({ command: 'complete', id, input: { content: 'Done', sources: [{ ref: 'x' }] } });
		tasks.push(id);
	}
	const project = ok({
		command: 'create_project',
		input: {
			title: 'Big project',
			outcome: 'o',
			milestones: [
				{
					title: 'M1',
					success_condition: 's',
					tasks: Array.from({ length: 100 }, (_, i) => ({
						title: `Step ${i}`,
						description: 'd',
						done_when: 'x'
					}))
				}
			]
		}
	});
	const asks = new Set();
	for (let i = 0; i < 1000; i++)
		asks.add(
			ok({
				command: 'raise_question',
				input: {
					prompt: long(i),
					impact: 'i',
					answerable_by: [w.owner],
					session: `agent:verl:s${i % 40}`,
					...(i % 3 === 0 ? { targets: [{ kind: 'project', id: project }] } : {}),
					...(i % 3 === 1 ? { targets: [{ kind: 'task', id: tasks[i % 50] }] } : {})
				}
			})
		);

	const home = await call('falcon_work_read', { view: 'home' });
	assert.equal(home.needs_you_total, 1000);
	assert.ok(home.needs_you.length > 0 && home.needs_you_next, 'Home carries the first page');
	assert.ok(!home.truncated, 'Home sizes itself; the last guard is not needed');
	const { totals, next } = home.board;
	assert.equal(totals.done, 100, JSON.stringify(totals));
	assert.ok(totals.moving > 40 && totals.waiting > 40, JSON.stringify(totals));
	assert.ok(next.moving && next.done, 'the longer columns carry more than Home shows');

	// Needs you: every ask exactly once, newest first.
	const seen = [...home.needs_you.map((n) => n.id)];
	for (let cursor = home.needs_you_next; cursor;) {
		const page = await call('falcon_work_read', { view: 'needs_you', cursor });
		assert.equal(page.total, 1000);
		seen.push(...page.items.map((n) => n.id));
		cursor = page.next;
	}
	assert.equal(seen.length, 1000);
	assert.deepEqual(new Set(seen), asks);

	// Each board column pages to its total.
	for (const column of ['moving', 'waiting', 'done']) {
		const ids = home.board[column].map((x) => x.id);
		for (let cursor = next[column]; cursor;) {
			const page = await call('falcon_work_read', { view: 'board', column, cursor });
			ids.push(...page.items.map((x) => x.id));
			cursor = page.next;
		}
		assert.equal(ids.length, totals[column], column);
		assert.equal(new Set(ids).size, ids.length, `${column}: no card twice`);
	}

	// Item pages carry a capped list of their asks and the total.
	const p = await call('falcon_work_read', { view: 'project', id: project });
	assert.ok(p.needs_you_total >= 334 && p.needs_you.length < p.needs_you_total);
	const t = await call('falcon_work_read', { view: 'task', id: tasks[1] });
	assert.ok(t.needs_you_total >= 1);
	await call('falcon_work_read', { view: 'get', id: project });
	await call('falcon_work_read', { view: 'search', text: 'Task' });
});
