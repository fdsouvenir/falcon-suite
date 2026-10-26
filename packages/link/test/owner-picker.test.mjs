import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { PERMISSIONS, BASE_SCOPES } from '../dist/model.js';

test('owner picker excludes system agents by roster kind, not by name', async () => {
	const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url)));
	const { default: plugin } = await import(
		new URL(`../${manifest.controlUi.entry}`, import.meta.url)
	);
	const { document, window } = parseHTML('<html><body><main></main></body></html>');
	window.matchMedia = () => ({ matches: false });
	// linkedom exposes select.value as getter-only; browsers also support setting it.
	const valueDescriptor = Object.getOwnPropertyDescriptor(
		window.HTMLSelectElement.prototype,
		'value'
	);
	Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
		...valueDescriptor,
		set(value) {
			for (const option of this.options) option.selected = option.value === value;
		}
	});
	const previous = { document: globalThis.document, window: globalThis.window };
	Object.assign(globalThis, { document, window });
	let view;
	const failedAccount = {
		id: 'acct_failed',
		provider: 'google',
		owner: { kind: 'human', id: 'fred', name: 'Fred' },
		purpose: { kind: 'personal' },
		email: null,
		provider_id: null,
		state: 'failed',
		requested: ['gmail-read'],
		granted_scopes: null
	};
	const host = {
		pluginId: manifest.id,
		signal: new AbortController().signal,
		connection: { connected: true, canRead: true, canWrite: true },
		request: async (method, payload) => {
			if (method === 'users.list') return { profiles: [{ id: 'fred', displayName: 'Fred' }] };
			if (method === 'agents.list')
				return {
					agents: [
						{ id: 'internal', kind: 'system', name: 'Renamed internal agent' },
						{ id: 'alpha', kind: 'agent', name: 'Alpha' },
						{ id: 'legacy', name: 'openclaw' }
					]
				};
			return {
				ok: true,
				result:
					payload.actionId === 'accounts'
						? { accounts: [failedAccount] }
						: {
								permissions: PERMISSIONS,
								baseline_scopes: BASE_SCOPES,
								integrations: ['google', 'microsoft'].map((id) => ({
									id,
									name: id,
									tool: { state: 'installed', version: '1.0.0' },
									setup: { state: 'ready' }
								}))
							}
			};
		},
		ui: {
			registerPage: (page) => {
				view = page.mount(document.querySelector('main'), { host, props: {} });
			},
			registerNavigation() {}
		}
	};
	try {
		plugin.activate(host);
		await setImmediate();
		const connect = [...document.querySelectorAll('button')].find(
			(b) => b.textContent === 'Connect account'
		);
		assert.ok(connect, document.body.textContent);
		connect.click();
		const picker = document.querySelector('select[aria-label="Owner"]');
		assert.ok(picker);
		assert.deepEqual(
			[...picker.querySelectorAll('option')].map((o) => o.value),
			['', 'human:fred', 'agent:alpha', 'agent:legacy']
		);
		[...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
		[...document.querySelectorAll('button')]
			.find((b) => b.textContent === 'Reconnect / permissions')
			.click();
		const email = document.querySelector('input[type=email]');
		assert.equal(email.readOnly, false, 'an unverified empty address must remain editable');
		assert.match(document.body.textContent, /Sign-in did not complete/);
	} finally {
		view?.dispose();
		Object.assign(globalThis, previous);
	}
});
