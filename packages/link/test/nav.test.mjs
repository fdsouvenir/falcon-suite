import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { BASE_SCOPES, PROVIDER_UI } from '../dist/providers/ui.js';

test('the Integrations nav lists integrations under their group, in group order', async () => {
	const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url)));
	const { default: plugin } = await import(
		new URL(`../${manifest.controlUi.entry}`, import.meta.url)
	);
	const { document, window } = parseHTML('<html><body><main></main></body></html>');
	window.matchMedia = () => ({ matches: false });
	const previous = { document: globalThis.document, window: globalThis.window };
	Object.assign(globalThis, { document, window });
	let view;
	const host = {
		pluginId: manifest.id,
		signal: new AbortController().signal,
		connection: { connected: true, canRead: true, canWrite: true },
		request: async (method, payload) => {
			if (method === 'users.list') return { profiles: [] };
			if (method === 'agents.list') return { agents: [] };
			if (payload?.actionId === 'viewer') return { ok: true, result: { profile_id: 'fred' } };
			if (payload?.actionId === 'accounts') return { ok: true, result: { accounts: [] } };
			return {
				ok: true,
				result: {
					catalogs: {},
					baseline_scopes: BASE_SCOPES,
					integrations: PROVIDER_UI.map(({ id, name, cli }) => ({
						id,
						name,
						cli,
						tool: { state: 'installed', version: '1.0.0' },
						setup: { state: 'ready' },
						managed: true,
						installable: true
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
		for (let i = 0; i < 50 && /Checking/.test(document.querySelector('.fl-nav').textContent); i++)
			await setImmediate();
		const groups = [...document.querySelectorAll('.fl-nav [role="group"]')].map((g) => ({
			name: document.getElementById(g.getAttribute('aria-labelledby'))?.textContent,
			heading: g.querySelector('h3')?.textContent,
			integrations: [...g.querySelectorAll('.fl-integration-name')].map((n) => n.textContent)
		}));
		// Every group has an integration, so all are shown.
		assert.deepEqual(groups, [
			{
				name: 'Productivity',
				heading: 'Productivity',
				integrations: ['Google', 'Microsoft']
			},
			{ name: 'Messaging', heading: 'Messaging', integrations: ['WhatsApp'] },
			{ name: 'CRM & Sales', heading: 'CRM & Sales', integrations: ['HubSpot', 'ZoomInfo'] },
			{ name: 'Payments', heading: 'Payments', integrations: ['Stripe Link'] },
			{ name: 'Files', heading: 'Files', integrations: ['Dropbox'] },
			{ name: 'Health', heading: 'Health', integrations: ['Google Health'] }
		]);
		const current = [...document.querySelectorAll('.fl-integration[aria-current="page"]')];
		assert.deepEqual(
			current.map((b) => b.querySelector('.fl-integration-name').textContent),
			['Google'],
			'the first integration is selected'
		);
		assert.match(current[0].textContent, /No accounts/);
	} finally {
		view?.dispose();
		Object.assign(globalThis, previous);
	}
});
