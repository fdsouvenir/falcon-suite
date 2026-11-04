import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { BASE_SCOPES } from '../dist/providers/ui.js';
import { PLUGIN_VERSION } from '../dist/identity.js';
import { googleCatalog } from '../dist/providers/google/catalog.js';
import { microsoftCatalog } from '../dist/providers/microsoft/catalog.js';
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
	const signedOutAccount = {
		...connectedAccount,
		id: 'acct_out',
		email: 'out@example.com',
		state: 'disconnected',
		requested: ['gmail:readonly'],
		recorded_scopes: null,
		replaces: 'existing_old',
		connection_error: {
			code: 'signed_out_by_reinstall',
			message:
				'Signed out when Google was reinstalled. Sign in again so your agents can use this account.'
		}
	};
	const g = (s) => `https://www.googleapis.com/auth/${s}`;
	const foundAccount = {
		id: 'existing_found',
		provider: 'google',
		owner: null,
		purpose: null,
		email: 'found@example.com',
		provider_id: null,
		state: 'discovered',
		requested: [],
		granted_scopes: null,
		external: { selection: 'found@example.com', client: 'default' },
		recorded_scopes: [
			'email',
			g('gmail.modify'),
			g('gmail.settings.basic'),
			g('calendar'),
			g('contacts'),
			g('drive'),
			g('documents'),
			g('spreadsheets'),
			g('chat.messages'),
			g('chat.spaces'),
			g('classroom.courses'),
			g('youtube.readonly')
		]
	};
	const invoked = [];
	let opened = false;
	window.open = () => {
		opened = true;
		return null;
	};
	const copied = [];
	Object.defineProperty(globalThis.navigator, 'clipboard', {
		value: { writeText: async (text) => void copied.push(text) },
		configurable: true
	});
	const host = {
		pluginId: manifest.id,
		signal: new AbortController().signal,
		connection: { connected: true, canRead: true, canWrite: true },
		request: async (method, payload) => {
			if (payload?.actionId === 'start') {
				return {
					ok: true,
					result: {
						id: 'login',
						provider: 'google',
						account_id: 'acct_failed',
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
						account_id: 'acct_failed',
						state: 'awaiting_consent',
						url: 'https://accounts.google.com/test-consent',
						message: 'Waiting for sign-in',
						hosted: true
					}
				};
			if (payload?.actionId === 'install') {
				invoked.push(payload);
				return { ok: true, result: { signed_out: ['acct_new'] } };
			}
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
									signedOutAccount,
									foundAccount,
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
									cli: id,
									tool: { state: 'installed', version: '1.0.0' },
									setup: { state: 'ready' },
									// Google's CLI was installed outside Link and an update is out.
									managed: id !== 'google',
									installable: true,
									update_available: id === 'google'
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
		const version = [...document.querySelectorAll('.fl-tool dt')].find(
			(dt) => dt.textContent === 'Falcon Link version'
		);
		assert.equal(
			version?.nextElementSibling.textContent,
			PLUGIN_VERSION,
			'Technical details show the full version'
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
		// Access reads as one row per service, opening from a one-line summary.
		const found = () =>
			[...document.querySelectorAll('.fl-account')].find((c) =>
				c.textContent.includes('found@example.com')
			);
		const access = found().querySelector('details.fl-access');
		assert.ok(access, 'a long access list collapses');
		assert.match(
			access.querySelector('summary').textContent,
			/^Gmail · Calendar · Contacts · Drive · Docs\+4 moreShow all$/
		);
		const rows = [...access.querySelectorAll('.fl-access-rows dt')].map((dt) => dt.textContent);
		assert.deepEqual(rows, [
			'Gmail',
			'Calendar',
			'Contacts',
			'Drive',
			'Docs',
			'Sheets',
			'Chat',
			'YouTube',
			'Classroom'
		]);
		assert.equal(
			access.querySelector('.fl-access-rows dd').textContent,
			'Read, send, organize and delete (to trash) email, Manage email settings'
		);
		// Owner and purpose change from the card itself and save without signing in.
		found().querySelector('.fl-account-details').click();
		assert.match(found().textContent, /Owner and purpose/);
		assert.ok(found().querySelector('select[aria-label="Owner"]'));
		assert.ok(
			[...found().querySelectorAll('button')].some((b) => b.textContent === 'Save'),
			'details save directly'
		);
		assert.equal(found().querySelector('.fl-signin'), null, 'no sign-in to change the owner');
		[...found().querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
		assert.doesNotMatch(document.body.textContent, /Edit details/);
		// A signed-out account says so plainly and offers to sign in again.
		const out = [...document.querySelectorAll('.fl-account')].find((c) =>
			c.textContent.includes('out@example.com')
		);
		assert.equal(out.querySelector('.fl-account-status-error')?.textContent, 'Signed out');
		assert.match(out.textContent, /Sign in again so your agents can use this account/);
		assert.ok([...out.querySelectorAll('button')].some((b) => b.textContent === 'Sign in again'));
		assert.match(
			document.querySelector('.fl-integration').textContent,
			/1 needs sign-in/,
			'the sidebar counts accounts waiting for sign-in'
		);
		// A CLI installed outside Link is one plain fix, confirmed first because it signs out
		// the accounts found in that CLI's own store.
		assert.doesNotMatch(document.body.textContent, /installed outside Link/);
		const fix = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Fix it');
		assert.ok(fix, document.body.textContent);
		fix.click();
		let dialog = document.querySelector('.fl-dialog');
		assert.ok(dialog, 'a warning appears before anything changes');
		assert.equal(invoked.length, 0);
		assert.match(dialog.textContent, /signs out this account:found@example\.com/);
		assert.match(dialog.textContent, /sign in to it again/);
		[...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
		assert.equal(document.querySelector('.fl-dialog'), null);
		assert.equal(invoked.length, 0, 'Cancel changes nothing');
		[...document.querySelectorAll('button')].find((b) => b.textContent === 'Fix it').click();
		dialog = document.querySelector('.fl-dialog');
		[...dialog.querySelectorAll('button')]
			.find((b) => b.textContent === 'Fix and sign out')
			.click();
		for (let i = 0; i < 50 && !invoked.length; i++) await setImmediate();
		assert.match(JSON.stringify(invoked[0]), /"replace":true/);
		for (
			let i = 0;
			i < 50 && !/up to date/.test(document.querySelector('.fl-notice').textContent);
			i++
		)
			await setImmediate();
		assert.match(
			document.querySelector('.fl-notice').textContent,
			/^google is up to date\. 1 account needs you to sign in again\.$/
		);
		const connect = [...document.querySelectorAll('button')].find(
			(b) => b.textContent === 'Add account'
		);
		assert.ok(connect, document.body.textContent);
		connect.click();
		const picker = document.querySelector('select[aria-label="Owner"]');
		assert.ok(picker);
		assert.ok(
			document.querySelector('.fl-detail > .fl-new select[aria-label="Owner"]'),
			'the new account form is a card in the accounts list, not a panel elsewhere'
		);
		assert.equal(
			[...document.querySelectorAll('button')].filter((b) => b.textContent === 'Add account')
				.length,
			0,
			'Add account is not offered twice while a form is open'
		);
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
		assert.ok(form.closest('.fl-account'), 'reconnect opens inside the account card');
		form.reportValidity = () => true;
		email.value = 'fred@example.com';
		assert.equal(
			form.querySelector('select[aria-label="Owner"]'),
			null,
			'changing access does not ask for the owner again'
		);
		document.querySelector('.fl-notice').textContent = '';
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await setImmediate();
		assert.equal(
			form.querySelector('.fl-form-error')?.textContent,
			'Choose access for at least one service.',
			'a form problem is shown in the form'
		);
		assert.equal(document.querySelector('.fl-notice').textContent, '');
		Object.defineProperty(document.querySelector('select[aria-label="Email"]'), 'value', {
			value: 'gmail:readonly',
			configurable: true
		});
		form.dispatchEvent(new window.Event('submit', { cancelable: true }));
		await setImmediate();
		assert.match(document.body.textContent, /Starting sign-in/);
		await new Promise((resolve) => setTimeout(resolve, 2200));
		const signing = document.querySelector('.fl-account .fl-signing-in');
		assert.ok(signing, 'the sign-in in progress lives inside the account card');
		assert.equal(document.querySelectorAll('.fl-signing-in').length, 1);
		assert.equal(
			document.querySelector('.fl-detail > .fl-signing-in, .fl-login'),
			null,
			'no separate sign-in panel'
		);
		const open = signing.querySelector('.fl-sign-in a');
		assert.equal(open?.textContent, 'Open sign-in');
		assert.equal(open.href, 'https://accounts.google.com/test-consent');
		assert.equal(open.target, '_blank');
		const copy = [...document.querySelectorAll('.fl-sign-in button')].find(
			(b) => b.textContent === 'Copy link'
		);
		assert.ok(copy, 'the sign-in address can be copied into another browser profile');
		copy.click();
		await setImmediate();
		assert.deepEqual(copied, ['https://accounts.google.com/test-consent']);
		assert.equal(copy.textContent, 'Copied');
		assert.match(document.body.textContent, /different browser profile or device/);
		assert.equal(opened, false, 'sign-in is offered as a link, never opened by the page itself');
	} finally {
		view?.dispose();
		delete globalThis.navigator.clipboard;
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
