import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { mountVault } from '../dist/ui/app.js';
import { PLUGIN_ID } from '../dist/identity.js';

test('typing and clearing search refreshes results without remounting the input', async (t) => {
	const { document, window } = parseHTML('<html><body><main></main></body></html>');
	const previousDocument = globalThis.document;
	globalThis.document = document;
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const container = document.querySelector('main');
	const controller = new AbortController();
	const queries = [];
	const entries = ['Alpha login', 'Beta login'].map((title) => ({
		title,
		path: title,
		uuid: title,
		group: '',
		username: '',
		url: ''
	}));
	let changed;
	let page;
	let navigations = 0;
	const context = (props = {}) => ({ host, signal: controller.signal, props });
	const host = {
		pluginId: PLUGIN_ID,
		signal: controller.signal,
		connection: { connected: true },
		subscribe: () => () => {},
		onEvent: (_event, listener) => {
			changed = listener;
			return () => {};
		},
		navigation: {
			pageHref: () => '#vault',
			openPage: ({ params }) => {
				navigations++;
				page.dispose();
				page = mountVault(container, context(params));
			}
		},
		request: async (_method, { payload }) => ({
			ok: true,
			result:
				payload.view === 'overview'
					? { total: 2, needs: 0, groups: [], root_entries: 2, recycle_bin: null }
					: (queries.push(payload),
						{
							entries: entries.filter(
								(e) =>
									!payload.search || e.title.toLowerCase().includes(payload.search.toLowerCase())
							)
						})
		})
	};
	try {
		page = mountVault(container, context({ g: 'Existing group' }));
		await setImmediate();
		const input = container.querySelector('input[type=search]');
		const type = async (value) => {
			input.value = value;
			input.dispatchEvent(new window.Event('input'));
			t.mock.timers.tick(201); // Pause after each letter, beyond the search debounce.
			await setImmediate();
			assert.ok(
				container.querySelector('input[type=search]') === input,
				'search must keep the same mounted input'
			);
			assert.equal(input.isConnected, true);
			assert.equal(input.value, value);
		};
		await type('a');
		await type('al');
		await type('alp');
		assert.equal(navigations, 0, 'typing must not navigate/remount the plugin page');
		assert.equal(queries.at(-1).search, 'alp');
		assert.equal(queries.at(-1).scope, undefined, 'search is across all groups');
		assert.deepEqual(
			[...container.querySelectorAll('.fv-row-title')].map((e) => e.textContent),
			['Alpha login']
		);
		changed({});
		await setImmediate();
		assert.ok(
			container.querySelector('input[type=search]') === input,
			'background refresh keeps the input too'
		);
		await type('');
		assert.equal(queries.at(-1).scope, 'all');
		assert.equal(container.querySelectorAll('.fv-row-title').length, 2);
		page.update(context({ q: 'beta' }));
		await setImmediate();
		assert.equal(input.value, 'beta', 'explicit navigation still restores a linked search');
		assert.equal(container.querySelector('.fv-row-title').textContent, 'Beta login');
		input.value = 'abandoned';
		input.dispatchEvent(new window.Event('input'));
		page.update(context({}));
		await setImmediate();
		const count = queries.length;
		t.mock.timers.tick(201);
		await setImmediate();
		assert.equal(queries.length, count, 'navigation cancels a pending search');
	} finally {
		page?.dispose();
		globalThis.document = previousDocument;
	}
});
