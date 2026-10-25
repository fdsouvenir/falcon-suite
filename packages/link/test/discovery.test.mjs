import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../dist/index.js';

test('private sessions receive Link discovery even without agent-owned accounts; public sessions do not', async () => {
	const stateDir = await mkdtemp(path.join(os.tmpdir(), 'link-discovery-'));
	let hook, service;
	plugin.register(
		new Proxy(
			{ id: 'falcon-link' },
			{
				get(target, key) {
					if (key in target) return target[key];
					if (key === 'registerService')
						return (value) => {
							service = value;
						};
					if (key === 'on')
						return (name, value) => {
							if (name === 'before_prompt_build') hook = value;
						};
					return () => {};
				}
			}
		)
	);
	try {
		await service.start({ stateDir });
		const result = await hook({}, { agentId: 'main', sessionKey: 'agent:main:dashboard:fixture' });
		assert.match(result?.prependContext ?? '', /falcon_link_accounts/);
		assert.match(result.prependContext, /falcon_link_status/);
		assert.equal(
			result.prependSystemContext,
			undefined,
			'connection facts add no operating instructions'
		);
		assert.equal(
			await hook({}, { agentId: 'main', sessionKey: 'agent:main:discord:group:fixture' }),
			undefined
		);
	} finally {
		await service.stop();
		await rm(stateDir, { recursive: true, force: true });
	}
});
