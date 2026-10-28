import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { BASE_SCOPES } from '../dist/model.js';
import { PLUGIN_VERSION } from '../dist/identity.js';
import { googleCatalog, microsoftCatalog } from '../dist/catalog.js';
import { services, workloads } from './catalogs.mjs';
const catalogs = { google: googleCatalog(services), microsoft: microsoftCatalog(workloads) };

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
	const connectedAccount = {
		...failedAccount,
		id: 'acct_connected',
		email: 'work@example.com',
		state: 'connected',
		requested: ['gmail-send'],
		recorded_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
		checked_at: '2026-10-26T18:38:13Z'
	};
	let opened = false;
	const navigated = [];
	window.open = () => {
		opened = true;
		return {
			opener: window,
			closed: false,
			document: parseHTML('<html><head></head><body></body></html>').document,
			location: { replace: (url) => navigated.push(url) },
			close() {
				this.closed = true;
			}
		};
	};
	const host = {
		pluginId: manifest.id,
		signal: new AbortController().signal,
		connection: { connected: true, canRead: true, canWrite: true },
		request: async (method, payload) => {
			if (payload?.actionId === 'start') {
				assert.equal(
					opened,
					true,
					'the sign-in tab opens during the original user gesture, before the async request'
				);
				return {
					ok: true,
					result: {
						id: 'login',
						provider: 'google',
						state: 'starting',
						url: null,
						message: 'Starting sign-in…',
						hosted: true
					}
				};
			}
			if (payload?.actionId === 'login')
				return {
					ok: true,
					result: {
						id: 'login',
						provider: 'google',
						state: 'awaiting_consent',
						url: 'https://accounts.google.com/test-consent',
						message: 'Waiting for sign-in',
						hosted: true
					}
				};
			if (payload?.actionId === 'viewer') return { ok: true, result: { profile_id: 'fred' } };
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
						? {
								accounts: [
									failedAccount,
									connectedAccount,
									{
										...connectedAccount,
										id: 'acct_empty',
										email: 'empty@example.com',
										granted_scopes: []
									}
								]
							}
						: {
								catalogs,
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
		assert.equal(
			document.querySelector('.fl-footer')?.textContent,
			`Falcon Link ${PLUGIN_VERSION}`,
			'the footer shows the full version'
		);
		assert.doesNotMatch(document.body.textContent, /\bv(?:dev|preview)\./);
		const account = [...document.querySelectorAll('.fl-account')].find((card) =>
			card.textContent.includes('work@example.com')
		);
		assert.ok(account, 'an account gets a structured, readable card');
		assert.match(account.textContent, /Read email/);
		assert.doesNotMatch(
			account.textContent,
			/Send email|Requested:|Granted scopes|Identity last checked|2026/
		);
		assert.equal(account.querySelector('.fl-account-access h5')?.textContent, 'Access');
		assert.doesNotMatch(account.textContent, /Recorded at sign-in|not confirmed/i);
		assert.equal(
			account.querySelector('.fl-account-manage').hasAttribute('open'),
			false,
			'routine actions start collapsed'
		);
		[...account.querySelectorAll('button')]
			.find((b) => b.textContent === 'Check connection')
			.click();
		const card = () =>
			[...document.querySelectorAll('.fl-account')].find((c) =>
				c.textContent.includes('work@example.com')
			);
		for (let i = 0; i < 50 && !/checked just now/.test(card().textContent); i++)
			await setImmediate();
		assert.match(
			card().querySelector('.fl-account-result')?.textContent ?? '',
			/^Working — checked just now$/,
			'the check result stays on its card after the page refreshes'
		);
		const empty = [...document.querySelectorAll('.fl-account')].find((card) =>
			card.textContent.includes('empty@example.com')
		);
		assert.match(empty.textContent, /No account service access/);
		assert.doesNotMatch(
			empty.textContent,
			/Send email|Read email/,
			'known empty grants never fall back to sign-in choices'
		);
		const connect = [...document.querySelectorAll('button')].find(
			(b) => b.textContent === 'Add account'
		);
		assert.ok(connect, document.body.textContent);
		connect.click();
		const picker = document.querySelector('select[aria-label="Owner"]');
		assert.ok(picker);
		assert.deepEqual(
			[...picker.querySelectorAll('option')].map((o) => [o.value, o.textContent]),
			[
				['', 'Choose an owner'],
				['human:fred', 'Fred (you)'],
				['agent:alpha', 'Alpha'],
				['agent:legacy', 'openclaw']
			]
		);
		[...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
		[...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again').click();
		const email = document.querySelector('input[type=email]');
		assert.equal(email.readOnly, false, 'an unverified empty address must remain editable');
		assert.match(document.body.textContent, /Needs attention/);
		const form = document.querySelector('.fl-form');
		form.reportValidity = () => true;
		email.value = 'fred@example.com';
		Object.defineProperty(document.querySelector('select[aria-label="Owner"]'), 'value', {
			value: 'human:fred',
			configurable: true
		});
		Object.defineProperty(document.querySelector('select[aria-label="Email"]'), 'value', {
			value: 'gmail:readonly',
			configurable: true
		});
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await setImmediate();
		assert.equal(opened, true, document.body.textContent);
		await new Promise((resolve) => setTimeout(resolve, 2200));
		assert.deepEqual(
			navigated,
			['https://accounts.google.com/test-consent'],
			'the reserved tab follows the URL when it becomes available'
		);
		assert.match(document.body.textContent, /Reopen sign-in/);
	} finally {
		view?.dispose();
		Object.assign(globalThis, previous);
	}
});

test('Microsoft mail-write discloses existing-email deletion, not just draft access', async () => {
	const { accessSummary } = await import('../dist/access-summary.js');
	const permission = catalogs.microsoft.rows
		.find((r) => r.id === 'mail')
		.levels.find((l) => l.id === 'mail-write');
	assert.match(permission.description, /read.*organize.*delete/i);
	assert.deepEqual(permission.scopes, ['Mail.ReadWrite']);
	const summary = accessSummary({
		provider: 'microsoft',
		state: 'connected',
		requested: ['mail-write'],
		granted_scopes: ['Mail.ReadWrite']
	});
	assert.match(summary.items.join(' '), /read.*organize.*delete/i);
	assert.doesNotMatch(summary.items.join(' '), /send/i);
});
