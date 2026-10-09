// The OpenClaw wiring (spec §6, §7, §9, §10): one agent tool that never returns a value, UI-only
// operations without tools, Usages from live config, and the asking agent told when a Request is
// filled. Runs the built plugin against a recording stand-in for the plugin API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../dist/index.js';
import { resetVault } from '../dist/plugin/runtime.js';
import { usagesOf, vaultReferences } from '../dist/store/usages.js';
import { externalDatabase, tempState } from './helpers.mjs';

const CONFIG = {
	secrets: {
		providers: {
			keepassxc: {
				source: 'exec',
				pluginIntegration: { pluginId: 'falcon-vault', integrationId: 'falcon-vault' }
			},
			other: { source: 'exec', command: '/bin/other' }
		}
	},
	models: {
		providers: {
			google: { apiKey: { source: 'exec', provider: 'keepassxc', id: 'Providers/google-gemini' } }
		}
	},
	channels: {
		telegram: { botToken: { source: 'exec', provider: 'keepassxc', id: 'Channels/telegram' } },
		discord: {
			accounts: {
				default: { token: { source: 'exec', provider: 'other', id: 'Channels/telegram' } }
			}
		}
	},
	plugins: {
		entries: {
			'homeassistant-agent-interface': {
				config: { token: { source: 'exec', provider: 'keepassxc', id: 'Home-Assistant:Password' } }
			}
		}
	},
	memory: {
		search: {
			remote: {
				apiKey: { source: 'exec', provider: 'keepassxc', id: 'Providers/google-gemini' },
				user: { source: 'exec', provider: 'keepassxc', id: 'Providers/google-gemini:UserName' }
			}
		}
	}
};

function load(runtime) {
	const reg = { services: [], tools: {}, actions: {}, logs: [], told: [] };
	const api = new Proxy(
		{},
		{
			get(_, key) {
				if (key === 'pluginConfig') return {};
				if (key === 'runtime') return runtime;
				if (key === 'logger')
					return { info: (m) => reg.logs.push(m), warn: (m) => reg.logs.push(m) };
				if (key === 'id') return 'falcon-vault';
				if (key === 'registerService') return (s) => reg.services.push(s);
				if (key === 'registerTool') return (factory, opts) => (reg.tools[opts.name] = factory);
				if (key === 'registerSessionAction') return (a) => (reg.actions[a.id] = a);
				return () => {};
			}
		}
	);
	plugin.register(api);
	return reg;
}

async function started(entries = []) {
	resetVault();
	const told = [];
	const runtime = {
		config: { current: () => CONFIG },
		system: { enqueueSystemEvent: (text, opts) => (told.push({ text, ...opts }), true) }
	};
	const reg = load(runtime);
	const stateDir = tempState();
	if (entries.length) await externalDatabase(stateDir, entries);
	const health = [];
	for (const s of reg.services)
		await s.start?.({
			stateDir,
			serviceHealth: {
				reportFailure: (e) => health.push(String(e)),
				clearFailure: () => health.push('ok')
			}
		});
	const call = async (params, agentId = 'verl', sessionKey = 'agent:verl:main') => {
		const tool = reg.tools.falcon_vault({ agentId, sessionKey });
		const r = await tool.execute(`call-${Math.random()}`, params);
		return r.details ?? JSON.parse(r.content[0].text);
	};
	const ui = async (id, payload) => {
		const r = await reg.actions[id].handler({
			pluginId: 'falcon-vault',
			actionId: id,
			payload,
			client: { connId: 'c', scopes: ['operator.write'] }
		});
		return r.result ?? r;
	};
	return { reg, call, ui, told, stateDir, health };
}

const ENTRIES = [
	[
		'Providers',
		'google-gemini',
		{ Password: 'gem-SECRET', UserName: 'me@x', URL: 'https://ai', Notes: 'notes-SECRET' }
	],
	['Channels', 'telegram', { Password: 'tg-SECRET' }],
	['', 'Home-Assistant', { Password: 'ha-SECRET' }]
];

test('one agent tool; reveal, copy and every write are UI operations without tools', async () => {
	const { reg, health } = await started(ENTRIES);
	assert.deepEqual(Object.keys(reg.tools), ['falcon_vault']);
	assert.deepEqual(Object.keys(reg.actions).sort(), ['agent', 'browse', 'edit', 'reveal']);
	assert.deepEqual(health, ['ok']);
});

test('the tool never returns a Password or Notes value', async () => {
	const { call } = await started(ENTRIES);
	const list = await call({ action: 'list' });
	assert.deepEqual(
		list.entries.map((e) => e.path),
		['Channels/telegram', 'Home-Assistant', 'Providers/google-gemini']
	);
	const gem = list.entries.find((e) => e.path === 'Providers/google-gemini');
	assert.equal(gem.username, 'me@x');
	assert.equal(gem.url, 'https://ai');
	assert.deepEqual(gem.set, { Password: true, UserName: true, URL: true, Notes: true });
	assert.equal(gem.reference, 'Providers/google-gemini');
	const get = await call({ action: 'get', path: 'Providers/google-gemini' });
	assert.deepEqual(
		get.usages.map((u) => [u.config_path, u.field]),
		[
			['models.providers.google.apiKey', 'Password'],
			['memory.search.remote.apiKey', 'Password'],
			['memory.search.remote.user', 'UserName']
		]
	);
	const stored = await call({
		action: 'store',
		group: 'Services',
		title: 'resend',
		password: 'chosen-SECRET',
		username: 'bot'
	});
	assert.equal(stored.outcome, 'committed');
	assert.equal(stored.reference, 'Services/resend');
	const all = JSON.stringify([
		list,
		get,
		stored,
		await call({ action: 'list', search: 'resend' }),
		await call({ action: 'get', path: 'Services/resend' })
	]);
	assert.doesNotMatch(all, /SECRET/);
	assert.ok(!('notes' in get) && !('password' in get));
});

test('store is create-only and never overwrites; the agent cannot change or remove entries', async () => {
	const { call, ui } = await started(ENTRIES);
	const r = await call({ action: 'store', title: 'Home-Assistant', password: 'replacement' });
	assert.equal(r.outcome, 'rejected');
	assert.equal(r.code, 'exists');
	const v = await ui('reveal', { path: 'Home-Assistant', field: 'Password', purpose: 'reveal' });
	assert.equal(v.value, 'ha-SECRET');
	assert.equal(
		(await call({ action: 'store', title: 'x' })).outcome,
		'rejected',
		'a store needs a password'
	);
	await assert.rejects(call({ action: 'edit', path: 'Home-Assistant' }));
});

test('a Request waits under Needs a value; filling it tells the asking session, never the value', async () => {
	const { call, ui, told } = await started(ENTRIES);
	const asked = await call({
		action: 'request',
		group: 'Services/APIs',
		title: 'stripe-restricted',
		username: 'finance-reader',
		reason: 'Needed to read payouts for the monthly finance summary.'
	});
	assert.equal(asked.outcome, 'committed');
	const overview = await ui('browse', { view: 'overview' });
	assert.equal(overview.needs, 1);
	assert.equal(overview.provider_alias, 'keepassxc');
	const needs = await ui('browse', { view: 'list', scope: 'needs' });
	assert.equal(needs.entries[0].request.actor, 'agent:verl');
	assert.equal(
		needs.entries[0].request.reason,
		'Needed to read payouts for the monthly finance summary.'
	);
	const filled = await ui('edit', {
		command: 'fill_request',
		path: 'Services/APIs/stripe-restricted',
		fields: { password: 'rk_live-SECRET' }
	});
	assert.equal(filled.outcome, 'committed');
	assert.equal(told.length, 1);
	assert.equal(told[0].sessionKey, 'agent:verl:main');
	assert.equal(told[0].agentId, 'verl');
	assert.match(told[0].text, /Services\/APIs\/stripe-restricted/);
	assert.doesNotMatch(told[0].text, /SECRET/);
	assert.equal((await ui('browse', { view: 'overview' })).needs, 0);
	assert.equal(
		(await call({ action: 'request', title: 'x', password: 'p', reason: 'r' })).outcome,
		'rejected'
	);
});

test('the entry view lists Usages from live config by path, and reveal is recorded', async () => {
	const { ui } = await started(ENTRIES);
	const e = await ui('browse', { view: 'entry', path: 'Home-Assistant' });
	assert.deepEqual(e.usages, [
		{
			config_path: 'plugins.entries.homeassistant-agent-interface.config.token',
			field: 'Password',
			label: 'homeassistant-agent-interface plugin — token'
		}
	]);
	assert.doesNotMatch(JSON.stringify(e), /ha-SECRET/, 'the entry view has no password');
	await ui('reveal', { path: 'Home-Assistant', field: 'Password', purpose: 'copy' });
	const h = await ui('browse', { view: 'history', path: 'Home-Assistant' });
	assert.deepEqual(
		h.events.map((x) => [x.actor, x.action]),
		[['person:gateway-owner', 'copy']]
	);
	const tg = await ui('browse', { view: 'entry', path: 'Channels/telegram' });
	assert.deepEqual(
		tg.usages.map((u) => u.config_path),
		['channels.telegram.botToken'],
		'another provider is not Vault'
	);
});

test('Usages are read from a config object, never stored', () => {
	assert.deepEqual(
		vaultReferences(CONFIG, 'falcon-vault').map((r) => [r.path, r.field]),
		[
			['Providers/google-gemini', 'Password'],
			['Channels/telegram', 'Password'],
			['Home-Assistant', 'Password'],
			['Providers/google-gemini', 'Password'],
			['Providers/google-gemini', 'UserName']
		]
	);
	assert.deepEqual(usagesOf({}, 'falcon-vault', 'Home-Assistant'), []);
	assert.deepEqual(
		usagesOf(CONFIG, 'someone-else', 'Home-Assistant'),
		[],
		'only this plugin’s provider'
	);
	const quoted = {
		...CONFIG,
		tools: { 'web.search': { keys: [{ source: 'exec', provider: 'keepassxc', id: 'k' }] } }
	};
	assert.equal(usagesOf(quoted, 'falcon-vault', 'k')[0].config_path, 'tools["web.search"].keys[0]');
});

test('when the database cannot open, the tab says why instead of showing an empty list', async () => {
	resetVault();
	const reg = load({ config: { current: () => ({}) }, system: {} });
	const stateDir = tempState();
	const { writeFileSync } = await import('node:fs');
	writeFileSync(`${stateDir}/vault.key`, 'orphan key');
	const health = [];
	for (const s of reg.services)
		await s.start({
			stateDir,
			serviceHealth: { reportFailure: (e) => health.push(String(e)), clearFailure() {} }
		});
	assert.match(health[0], /passwords\.kdbx is missing/);
	const r = await reg.actions.browse.handler({
		payload: { view: 'overview' },
		client: { connId: 'c', scopes: ['operator.read'] }
	});
	const out = r.result ?? r;
	assert.match(out.unavailable, /passwords\.kdbx is missing/);
});
