import { defineControlUiPlugin, type ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from './contract.js';
import { PLUGIN_ID, PLUGIN_VERSION } from './identity.js';
import type { IntegrationStatus, Overview } from './status.js';
import {
	type Account,
	type Catalog,
	type Owner,
	type Purpose,
	type Provider,
	offeredSelection,
	selectionScopes
} from './model.js';
import './control-ui.css';
import { accessSummary } from './access-summary.js';
import { PROVIDER_UI, uiOf } from './providers/ui.js';
import type { Revoke } from './providers/types.js';
// Official provider artwork, unmodified (see assets/brand/README.md).
import googleSignIn from '../assets/brand/google-signin-light-square.svg' with { type: 'text' };
import microsoftSignIn from '../assets/brand/microsoft-signin-light.svg' with { type: 'text' };
import microsoftLogo from '../assets/brand/microsoft-logo.svg' with { type: 'text' };
import hubspotLogo from '../assets/brand/hubspot-logo.svg' with { type: 'text' };
import dropboxGlyph from '../assets/brand/dropbox-glyph.svg' with { type: 'text' };
import zoominfoLogo from '../assets/brand/zoominfo-logomark.svg' with { type: 'text' };

const svg = (source: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
// Provider artwork by integration ID. Integrations without artwork use a neutral initial.
const LOGOS: Record<string, string> = {
	microsoft: microsoftLogo,
	hubspot: hubspotLogo,
	dropbox: dropboxGlyph,
	zoominfo: zoominfoLogo
};
// Artwork with built-in clear space is shown larger so the mark matches the others.
const PADDED = new Set(['dropbox']);
const SIGN_IN_ART: Record<string, string> = { google: googleSignIn, microsoft: microsoftSignIn };
// Providers without an official sign-in button: their logo beside Link's own button text.
const SIGN_IN_LOGO = new Set(['dropbox', 'zoominfo']);
const name = (id: Provider) => uiOf(id).name;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
	const n = document.createElement(tag);
	if (text !== undefined) n.textContent = text;
	if (cls) n.className = cls;
	return n;
}
function button(text: string, action: () => void | Promise<void>, primary = false) {
	const b = el('button', text, `fl-btn${primary ? ' fl-btn-primary' : ''}`);
	b.type = 'button';
	b.addEventListener('click', () => void action());
	return b;
}
function link(text: string, href: string) {
	const a = el('a', text);
	a.href = href;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	return a;
}
function field(label: string, control: HTMLElement) {
	control.setAttribute('aria-label', label);
	const l = el('label', undefined, 'fl-field');
	l.append(el('span', label), control);
	return l;
}
function select(options: { value: string; label: string }[], value?: string) {
	const s = el('select');
	for (const o of options) {
		const n = el('option', o.label);
		n.value = o.value;
		s.append(n);
	}
	if (value) s.value = value;
	return s;
}
function mark(provider: Provider, large = false) {
	const cls = `fl-provider-mark${large ? ' fl-provider-mark-large' : ''}`;
	const node = el('span', LOGOS[provider] ? undefined : name(provider).slice(0, 1), cls);
	if (LOGOS[provider]) {
		const logo = el('img', undefined, PADDED.has(provider) ? 'fl-logo-padded' : undefined);
		logo.src = svg(LOGOS[provider]);
		logo.alt = '';
		node.append(logo);
	}
	node.setAttribute('aria-hidden', 'true');
	return node;
}
// The provider's sign-in artwork, where it has one, is the action that starts sign-in.
function signInButton(provider: Provider) {
	const text = uiOf(provider).connect;
	if (SIGN_IN_LOGO.has(provider)) {
		const b = el('button', undefined, 'fl-btn fl-btn-provider');
		const logo = el('img');
		logo.src = svg(LOGOS[provider]);
		logo.alt = '';
		b.append(logo, el('span', text));
		return b;
	}
	if (!SIGN_IN_ART[provider]) return el('button', text, 'fl-btn fl-btn-primary');
	const b = el('button', undefined, 'fl-signin');
	b.type = 'submit';
	b.setAttribute('aria-label', text);
	const art = el('img');
	art.src = svg(SIGN_IN_ART[provider]);
	art.alt = '';
	b.append(art);
	return b;
}
// For sign-ins that end on an address the person copies back: what will happen, in steps,
// before they go and while Link waits.
function pasteWarning(provider: Provider) {
	const w = uiOf(provider).paste_warning;
	if (!w) return null;
	const box = el('section', undefined, 'fl-callout');
	box.setAttribute('role', 'note');
	const title = el('h4', w.title, 'fl-callout-title');
	title.id = `fl-callout-${provider}-${Math.random().toString(36).slice(2)}`;
	box.setAttribute('aria-labelledby', title.id);
	const steps = el('ol', undefined, 'fl-callout-steps');
	for (const step of w.steps) steps.append(el('li', step));
	box.append(title, steps);
	return box;
}
// "To remove access you've already given, use <provider page>."
function revokeSentence(r: Revoke) {
	const p = el('p', "To remove access you've already given, use ", 'fl-muted');
	p.append(r.lead);
	r.links.forEach((l, i) => p.append(...(i ? [' or '] : []), link(l.label, l.href)));
	p.append('.');
	return p;
}
type Login = {
	provider: Provider;
	id: string;
	account_id: string;
	state: string;
	message: string;
	url: string | null;
	code: string | null;
	expires_at: string;
	hosted?: boolean;
	paste?: { label: string; kind: 'url' | 'text' };
	step?: { number: number; total: number };
};
type StartInput = {
	provider: Provider;
	owner: Owner;
	purpose: Purpose;
	permissions: string[];
	account_id?: string;
	email?: string;
};
const ACTIVE = ['starting', 'awaiting_consent', 'verifying'];
function mount(container: HTMLElement, context: ControlUiViewContext) {
	const host = context.host;
	const client = createFeatureClient(contract, host);
	const root = el('section', undefined, 'fl-page');
	const header = el('header', undefined, 'fl-header');
	const heading = el('div');
	heading.append(
		el('h1', 'Falcon Link'),
		el('p', 'Manage account connections for your agents.', 'fl-page-description')
	);
	header.append(heading);
	const notification = el('p', undefined, 'fl-notice');
	notification.setAttribute('role', 'status');
	const layout = el('div', undefined, 'fl-layout');
	const nav = el('nav', undefined, 'fl-nav');
	nav.setAttribute('aria-label', 'Integrations');
	const detail = el('div', undefined, 'fl-detail');
	const formHost = el('div', undefined, 'fl-form-host');
	layout.append(nav, detail);
	root.append(header, notification, layout);
	container.append(root);
	let selected: Provider | null =
		(context.props.integration as Provider) ||
		(window.matchMedia('(max-width: 700px)').matches ? null : PROVIDER_UI[0].id);
	let status:
		| (Overview & {
				catalogs: Record<Provider, Catalog | null>;
				baseline_scopes: Record<Provider, string[]>;
		  })
		| null = null;
	let accounts: Account[] = [];
	let owners: Owner[] = [];
	let viewer: string | null = null;
	let disposed = false;
	let refreshing = false;
	let poll: ReturnType<typeof setTimeout> | undefined;
	let activeLogin: Login | null = null;
	let lastStart: StartInput | null = null;
	// Reserve the tab during the user's gesture; async provider setup can outlive popup permission.
	let signInTab: Window | null = null;
	let signInOpened = false;
	function closePendingTab() {
		signInTab?.close();
		signInTab = null;
	}
	function followSignIn() {
		if (!activeLogin) return;
		if (activeLogin.url && signInTab) {
			if (!signInTab.closed && new URL(activeLogin.url).protocol === 'https:') {
				signInTab.location.replace(activeLogin.url);
				signInOpened = true;
			}
			signInTab = null;
		} else if (!['starting', 'awaiting_consent'].includes(activeLogin.state)) closePendingTab();
	}
	let formDisposer: (() => void) | undefined;
	// Check connection results and open Manage sections stay with their card across refreshes.
	const checks = new Map<string, { busy: boolean; error?: string }>();
	const managing = new Set<string>();
	// An account's own form or confirmation opens inside its card, replacing the card's actions.
	let cardForm: { account: string; node: HTMLElement } | null = null;
	const message = (s: string, error = false) => {
		notification.textContent = s;
		notification.classList.toggle('fl-error', error);
	};
	const canWrite = () => host.connection.canWrite;
	async function act<T>(b: HTMLButtonElement, action: () => Promise<T>, success?: string) {
		b.disabled = true;
		try {
			const r = await action();
			if (disposed) return;
			if (success) message(success);
			return r;
		} catch (e) {
			if (!disposed) message((e as Error).message || 'The operation failed. Try again.', true);
		} finally {
			if (!disposed) b.disabled = !canWrite();
		}
	}
	function navigate(id: Provider | null) {
		selected = id;
		closeForm();
		host.navigation.openPage({ id: 'link', params: id ? { integration: id } : {} });
		render();
	}
	const refresh = button('Refresh', async () => load());
	header.append(refresh);
	function closeForm() {
		formDisposer?.();
		formDisposer = undefined;
		formHost.replaceChildren();
		if (cardForm) {
			cardForm = null;
			render();
		}
	}
	function openInCard(account: Account, node: HTMLElement, title: HTMLElement) {
		cardForm = { account: account.id, node };
		render();
		title.tabIndex = -1;
		title.focus();
	}
	async function load() {
		if (refreshing || disposed) return;
		refreshing = true;
		refresh.disabled = true;
		try {
			const [s, a] = await Promise.all([
				client.invoke('status', {}),
				client.invoke('accounts', {})
			]);
			if (disposed) return;
			status = s as typeof status;
			accounts = (a as { accounts: Account[] }).accounts;
			render();
		} catch (e) {
			if (!disposed)
				message((e as Error).message || 'Integration status could not be loaded.', true);
		} finally {
			refreshing = false;
			if (!disposed) refresh.disabled = false;
		}
	}
	async function loadOwners() {
		const [humans, agents, me] = await Promise.allSettled([
			host.request<{ profiles: { id: string; displayName?: string; mergedInto?: string }[] }>(
				'users.list',
				{}
			),
			host.request<{
				agents: {
					id: string;
					kind?: 'agent' | 'system';
					name?: string;
					identity?: { name?: string };
				}[];
			}>('agents.list', {}),
			client.invoke('viewer', {})
		]);
		if (disposed) return;
		if (me.status === 'fulfilled')
			viewer = (me.value as { profile_id?: string }).profile_id ?? null;
		owners = [];
		if (humans.status === 'fulfilled')
			owners.push(
				...humans.value.profiles
					.filter((p) => !p.mergedInto)
					.map((p) => ({ kind: 'human' as const, id: p.id, name: p.displayName || p.id }))
			);
		if (agents.status === 'fulfilled')
			owners.push(
				...agents.value.agents
					.filter((a) => a.kind !== 'system')
					.map((a) => ({
						kind: 'agent' as const,
						id: a.id,
						name: a.identity?.name || a.name || a.id
					}))
			);
		if (humans.status === 'rejected' || agents.status === 'rejected')
			message('Some people or agents could not be loaded. Only those shown can be chosen.', true);
	}
	function metadataFields(owner?: Owner, purpose?: Purpose) {
		const choices = [
			{ value: '', label: 'Choose an owner' },
			...owners.map((o) => ({
				value: `${o.kind}:${o.id}`,
				label: o.kind === 'human' && o.id === viewer ? `${o.name} (you)` : o.name
			}))
		];
		const ownerPicker = select(choices, owner ? `${owner.kind}:${owner.id}` : '');
		ownerPicker.required = true;
		const purposePicker = select(
			[
				{ value: 'work', label: 'Work' },
				{ value: 'personal', label: 'Personal' },
				{ value: 'other', label: 'Other' }
			],
			purpose?.kind
		);
		const custom = el('input');
		custom.type = 'text';
		custom.maxLength = 40;
		custom.placeholder = 'Short purpose label';
		custom.value = purpose?.label ?? '';
		const customField = field('Purpose label', custom);
		const toggle = () => {
			customField.hidden = purposePicker.value !== 'other';
			custom.required = !customField.hidden;
		};
		purposePicker.addEventListener('change', toggle);
		toggle();
		return {
			nodes: [field('Owner', ownerPicker), field('Purpose', purposePicker), customField],
			values: () => ({
				owner: owners.find((o) => `${o.kind}:${o.id}` === ownerPicker.value)!,
				purpose: {
					kind: purposePicker.value as Purpose['kind'],
					...(purposePicker.value === 'other' ? { label: custom.value.trim() } : {})
				}
			})
		};
	}
	// One row per service: a single choice (Off or a level), plus an addon where the provider
	// grants it separately. Scope strings appear only under Technical details.
	function permissionRows(provider: Provider, saved: string[]) {
		const catalog = status!.catalogs[provider];
		const node = el('fieldset', undefined, 'fl-permissions');
		node.append(el('legend', 'Access'));
		const pickers: (() => string[])[] = [];
		if (!catalog) {
			node.append(el('p', 'Permission choices could not be read from the CLI.', 'fl-muted'));
			return { node, selected: () => [] as string[] };
		}
		const technical = el('details', undefined, 'fl-technical');
		const scopeList = el('p', undefined, 'fl-scopes');
		technical.append(
			el('summary', 'Technical details'),
			...(catalog.technical ?? []).map((line) => el('p', line, 'fl-muted')),
			scopeList
		);
		// Collapsed sections for rows outside the main group, with an optional note shown while
		// any of their rows is on.
		const sections = new Map<
			string,
			{
				details: HTMLDetailsElement;
				body: HTMLElement;
				chosen: HTMLElement | null;
				pickers: (() => string[])[];
			}
		>();
		const update = () => {
			for (const s of sections.values())
				if (s.chosen) s.chosen.hidden = !s.pickers.some((p) => p().length);
			try {
				scopeList.textContent = selectionScopes(
					uiOf(provider),
					catalog,
					pickers.flatMap((p) => p())
				).join('\n');
			} catch {
				scopeList.textContent = 'Choose access for at least one service.';
			}
		};
		const initial = new Set(offeredSelection(uiOf(provider), catalog, saved));
		for (const row of catalog.rows) {
			const line = el('div', undefined, 'fl-permission');
			const copy = el('div', undefined, 'fl-permission-copy');
			const description = el('p', '', 'fl-muted');
			const choice = select(
				[{ value: '', label: 'Off' }, ...row.levels.map((l) => ({ value: l.id, label: l.label }))],
				row.levels.find((l) => initial.has(l.id))?.id ?? ''
			);
			const describe = () => {
				description.textContent =
					row.levels.find((l) => l.id === choice.value)?.description ?? row.description ?? '';
			};
			let syncAddon = () => {};
			choice.addEventListener('change', () => {
				syncAddon();
				describe();
				update();
			});
			describe();
			copy.append(
				el('span', row.label, 'fl-permission-name'),
				description,
				...[
					row.work_only ? 'Work or school accounts only' : '',
					row.admin_consent ? "Needs approval from your organization's administrator" : '',
					row.note ?? ''
				]
					.filter(Boolean)
					.map((n) => el('p', n, 'fl-muted fl-permission-note'))
			);
			const controls = el('div', undefined, 'fl-permission-controls');
			if (row.levels.length) {
				choice.setAttribute('aria-label', row.label);
				controls.append(choice);
			}
			let addon: HTMLInputElement | null = null;
			if (row.addon) {
				addon = el('input');
				addon.type = 'checkbox';
				addon.checked = initial.has(row.addon.id);
				addon.addEventListener('change', update);
				const label = el('label', undefined, 'fl-check');
				label.append(addon, el('span', row.addon.label));
				controls.append(label);
				const box = addon;
				// An addon that depends on a level is offered only while that level is chosen.
				if (row.addon_requires) {
					syncAddon = () => {
						label.hidden = choice.value !== row.addon_requires;
						if (label.hidden) box.checked = false;
					};
					syncAddon();
				}
			}
			const level = row.levels.length ? choice : null;
			const extra = row.addon ? { id: row.addon.id, input: addon! } : null;
			const picker = () => [
				...(level?.value ? [level.value] : []),
				...(extra?.input.checked ? [extra.id] : [])
			];
			pickers.push(picker);
			line.append(copy, controls);
			if (row.group === 'main') {
				node.append(line);
				continue;
			}
			let section = sections.get(row.group);
			if (!section) {
				const info = catalog.groups?.[row.group];
				const details = el('details', undefined, 'fl-more');
				const body = el('div');
				details.append(el('summary', info?.title ?? `More ${name(provider)} services`), body);
				if (info?.note) body.append(el('p', info.note, 'fl-muted fl-group-note'));
				const chosen = info?.chosen_note ? el('p', info.chosen_note, 'fl-group-chosen') : null;
				node.append(details);
				section = { details, body, chosen, pickers: [] };
				sections.set(row.group, section);
			}
			section.body.append(line);
			section.pickers.push(picker);
			// Changing access opens a section that already has choices.
			if (picker().length) section.details.open = true;
		}
		for (const s of sections.values()) if (s.chosen) s.body.append(s.chosen);
		node.append(technical);
		update();
		return { node, selected: () => pickers.flatMap((p) => p()) };
	}
	async function startSignIn(input: StartInput) {
		closePendingTab();
		signInOpened = false;
		signInTab = window.open('about:blank', '_blank');
		if (signInTab) {
			signInTab.opener = null;
			signInTab.document.title = 'Opening sign-in · Falcon Link';
			signInTab.document.body.textContent =
				'Opening secure sign-in… Your provider will appear here shortly. Keep your Office tab open.';
		}
		try {
			lastStart = input;
			if (input.account_id) checks.delete(input.account_id);
			const l = await client.invoke('start', input);
			if (disposed) {
				closePendingTab();
				return;
			}
			activeLogin = l as Login;
			followSignIn();
		} catch (error) {
			closePendingTab();
			throw error;
		}
		closeForm();
		await load();
		scheduleLogin();
	}
	// Saved choices are enough to go straight back to the provider; otherwise open the form.
	function retryInput(a: Account): StartInput | null {
		const ui = uiOf(a.provider);
		if (!a.owner || !a.purpose) return null;
		if (ui.permissions === 'catalog' && !a.requested.length) return null;
		if (ui.email_required && !a.email) return null;
		if (a.auth === 'service_key') return null;
		return {
			provider: a.provider,
			owner: a.owner,
			purpose: a.purpose,
			permissions: a.requested,
			account_id: a.id,
			...(ui.email_required ? { email: a.email! } : {})
		};
	}
	function accountForm(account?: Account, metadataOnly = false) {
		if (!selected || !status) return;
		closeForm();
		const provider = selected;
		const ui = uiOf(provider);
		const form = el('form', undefined, account ? 'fl-form fl-card-form' : 'fl-form');
		const title = el(
			account ? 'h5' : 'h3',
			metadataOnly ? 'Account details' : account ? 'Change access' : `Add a ${ui.name} account`
		);
		form.append(title);
		const meta = metadataFields(account?.owner ?? undefined, account?.purpose ?? undefined);
		form.append(...meta.nodes);
		const rows =
			metadataOnly || ui.permissions !== 'catalog'
				? null
				: permissionRows(provider, account?.requested ?? []);
		const email = el('input');
		email.type = 'email';
		email.maxLength = 254;
		email.value = account?.email ?? '';
		email.required = !!ui.email_required && !metadataOnly;
		email.readOnly = !!account?.email && !!ui.email_required;
		email.autocomplete = 'email';
		if (rows) form.append(rows.node);
		else if (!metadataOnly && ui.consent_note) form.append(el('p', ui.consent_note, 'fl-muted'));
		if (!metadataOnly && !rows && ui.technical) {
			const technical = el('details', undefined, 'fl-technical');
			technical.append(
				el('summary', 'Technical details'),
				...ui.technical.map((line) => el('p', line, 'fl-muted fl-scopes'))
			);
			form.append(technical);
		}
		if (!metadataOnly && account && ui.revoke) form.append(revokeSentence(ui.revoke(account)));
		const warning = metadataOnly ? null : pasteWarning(provider);
		if (warning) form.append(warning);
		const submit = metadataOnly
			? el('button', 'Save', 'fl-btn fl-btn-primary')
			: signInButton(provider);
		submit.type = 'submit';
		submit.disabled = !canWrite();
		const actions = el('div', undefined, 'fl-actions fl-signin-row');
		if (!metadataOnly && ui.email_required)
			actions.append(field(`${ui.name} account address`, email));
		actions.append(submit, button('Cancel', closeForm));
		form.append(actions);
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!form.reportValidity()) return;
			void act(submit, async () => {
				const values = meta.values();
				if (!values.owner) throw new Error('Choose an owner.');
				if (!rows && account) {
					await client.invoke('metadata', { account_id: account.id, ...values });
					closeForm();
					await load();
					return;
				}
				const permissions = rows ? rows.selected() : [];
				if (rows && !permissions.length) throw new Error('Choose access for at least one service.');
				await startSignIn({
					provider,
					...values,
					permissions,
					...(account ? { account_id: account.id } : {}),
					...(ui.email_required ? { email: email.value.trim() } : {})
				});
			});
		});
		if (account) return openInCard(account, form, title);
		formHost.append(form);
		title.tabIndex = -1;
		title.focus();
	}
	// Connects with a pasted service key instead of a sign-in; the key is sent once and never shown again.
	function keyForm(account?: Account) {
		if (!selected || !status) return;
		closeForm();
		const provider = selected;
		const ui = uiOf(provider);
		if (!ui.key) return;
		const form = el('form', undefined, account ? 'fl-form fl-card-form' : 'fl-form');
		const title = el(account ? 'h5' : 'h3', account ? 'Replace service key' : ui.key.action);
		form.append(title, el('p', ui.key.help, 'fl-muted'));
		const meta = metadataFields(account?.owner ?? undefined, account?.purpose ?? undefined);
		form.append(...meta.nodes);
		const key = el('input');
		key.type = 'password';
		key.required = true;
		key.maxLength = 1024;
		key.autocomplete = 'off';
		key.spellcheck = false;
		form.append(field(ui.key.field, key), el('p', ui.key.note, 'fl-muted'));
		const submit = el('button', 'Connect', 'fl-btn fl-btn-primary');
		submit.type = 'submit';
		submit.disabled = !canWrite();
		const actions = el('div', undefined, 'fl-actions');
		actions.append(submit, button('Cancel', closeForm));
		form.append(actions);
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!form.reportValidity()) return;
			void act(
				submit,
				async () => {
					const values = meta.values();
					if (!values.owner) throw new Error('Choose an owner.');
					const value = key.value;
					key.value = '';
					await client.invoke('connect_key', {
						provider,
						...values,
						key: value,
						...(account ? { account_id: account.id } : {})
					});
					closeForm();
					await load();
				},
				'Account connected.'
			);
		});
		if (account) return openInCard(account, form, title);
		formHost.append(form);
		title.tabIndex = -1;
		title.focus();
	}
	function scheduleLogin() {
		clearTimeout(poll);
		if (disposed || !activeLogin || !ACTIVE.includes(activeLogin.state)) return;
		poll = setTimeout(async () => {
			try {
				const next = (await client.invoke('login', { id: activeLogin!.id })) as Login;
				if (disposed) return;
				const changed = JSON.stringify(next) !== JSON.stringify(activeLogin);
				activeLogin = next;
				followSignIn();
				if (changed) await load();
				scheduleLogin();
			} catch {
				if (!disposed)
					message('Sign-in status could not be refreshed. Refresh the page or try again.', true);
			}
		}, 2000);
	}
	function loginCard() {
		if (!activeLogin) return null;
		const login = activeLogin;
		const card = el('section', undefined, 'fl-card fl-login');
		card.setAttribute('aria-live', 'polite');
		const dismiss = button('Dismiss', () => {
			activeLogin = null;
			render();
		});
		const retry = button('Try again', async () => {
			await act(retry, async () => startSignIn(lastStart!));
		});
		retry.disabled = !canWrite() || !lastStart;
		if (ACTIVE.includes(login.state)) {
			card.append(el('h3', 'Signing in…'));
			if (login.step)
				card.append(el('p', `Step ${login.step.number} of ${login.step.total}`, 'fl-muted'));
			card.append(el('p', login.message));
			const warning = login.state === 'verifying' ? null : pasteWarning(login.provider);
			if (warning) card.append(warning);
			// A later step needs the person to open the provider again themselves.
			const later = (login.step?.number ?? 1) > 1;
			if (login.url) {
				if (!later)
					card.append(
						el(
							'p',
							signInOpened
								? 'Sign-in opened in a new tab.'
								: 'Your browser may have blocked the sign-in tab. Open sign-in to continue.',
							'fl-muted'
						)
					);
				const a = link(!later && signInOpened ? 'Reopen sign-in' : 'Open sign-in', login.url);
				a.className = later ? 'fl-btn fl-btn-primary' : 'fl-btn';
				card.append(a);
			}
			if (login.code) card.append(el('p', login.code, 'fl-device-code'));
			if (login.url && login.paste && login.state === 'awaiting_consent') {
				const form = el('form', undefined, 'fl-paste');
				const input = el('input');
				input.type = login.paste.kind;
				input.required = true;
				input.maxLength = 8192;
				input.autocomplete = 'off';
				const finish = el('button', 'Continue', 'fl-btn fl-btn-primary');
				finish.type = 'submit';
				finish.disabled = !canWrite();
				form.append(field(login.paste.label, input), finish);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void act(finish, async () => {
						const value = input.value;
						input.value = '';
						activeLogin = (await client.invoke('finish', {
							id: login.id,
							redirect: value
						})) as Login;
						if (!disposed) await load();
					});
				});
				card.append(form);
			}
			if (login.state !== 'verifying') {
				const cancel = button('Cancel sign-in', async () => {
					await act(cancel, async () => {
						activeLogin = (await client.invoke('cancel', { id: login.id })) as Login;
						closePendingTab();
						await load();
					});
				});
				cancel.disabled = !canWrite();
				card.append(cancel);
			}
			return card;
		}
		const actions = el('div', undefined, 'fl-actions');
		if (login.state === 'connected') card.append(el('p', login.message));
		else if (login.state === 'cancelled') {
			card.append(el('p', login.message));
			actions.append(retry);
		} else {
			card.append(el('p', login.message, 'fl-error'));
			actions.append(retry);
		}
		actions.append(dismiss);
		card.append(actions);
		return card;
	}
	const signingIn = (a: Account) =>
		activeLogin?.account_id === a.id && ACTIVE.includes(activeLogin.state);
	// One vocabulary wherever a status appears. Connected is the quiet default and is not shown.
	function accountWord(a: Account) {
		if (signingIn(a)) return 'Signing in…';
		if (a.state === 'connected' || a.state === 'discovered') return 'Connected';
		if (a.state === 'disconnected') return 'Not connected';
		return 'Needs attention';
	}
	function attentionWord(provider: Provider) {
		const words: string[] = accounts.filter((a) => a.provider === provider).map(accountWord);
		return ['Needs attention', 'Not connected'].find((w) => words.includes(w)) ?? null;
	}
	const ready = (i: IntegrationStatus) =>
		i.setup.state === 'ready' && i.tool.state !== 'not_installed' && !i.below_minimum;
	// Plain banners only when something needs doing; otherwise no plumbing is shown.
	function banners(i: IntegrationStatus) {
		const list = el('div', undefined, 'fl-banners');
		const add = (text: string, action?: HTMLButtonElement) => {
			const b = el('div', undefined, 'fl-banner');
			b.setAttribute('role', 'status');
			b.append(el('p', text));
			if (action) b.append(action);
			list.append(b);
		};
		const install = (label: string) => {
			const b = button(label, async () => {
				await act(
					b,
					async () => {
						await client.invoke('install', { provider: i.id });
						await load();
					},
					`${i.cli} is ready.`
				);
			});
			b.disabled = !canWrite();
			return b;
		};
		const outside = `${i.cli} was installed outside Link.`;
		if (i.setup.state !== 'ready') add(i.setup.message);
		if (i.tool.state === 'not_installed' && i.no_build)
			add(`${i.name} doesn't publish a ${i.cli} build for this computer.`);
		else if (i.tool.state === 'not_installed')
			add(
				i.installable
					? `Install ${i.cli} to connect ${i.name} accounts.`
					: `Install ${i.cli} on this computer to connect ${i.name} accounts. Link can install it for you only on Linux.`,
				i.installable ? install('Install') : undefined
			);
		else if (i.below_minimum)
			add(
				`Update needed to connect ${i.name} accounts.${i.managed && i.installable ? '' : ' ' + outside}`,
				i.managed && i.installable ? install('Update') : undefined
			);
		else if (i.update_available)
			add(
				`A ${i.name} update is available.${i.managed && i.installable ? '' : ' ' + outside}`,
				i.managed && i.installable ? install('Update') : undefined
			);
		return list.childElementCount ? list : null;
	}
	// One row for the integration's official agent skills, shared by every agent.
	function skillsRow(i: IntegrationStatus) {
		const s = i.skills;
		if (!s) return null;
		const row = el('section', undefined, 'fl-banner fl-skills');
		row.setAttribute('role', 'status');
		const copy = el('div');
		copy.append(
			el('h3', 'Skills for your agents'),
			el(
				'p',
				s.state === 'installed'
					? `${i.name}'s official skills are installed for every agent on this Office.`
					: s.state === 'update_available'
						? `An update to ${i.name}'s official skills is available.`
						: s.state === 'unavailable'
							? s.message
							: `Install ${i.name}'s official skills so every agent on this Office knows how to use ${i.name}.`,
				'fl-muted'
			)
		);
		row.append(copy);
		const run = (label: string, action: 'install' | 'remove', primary: boolean, done: string) => {
			const b = button(
				label,
				async () => {
					await act(
						b,
						async () => {
							await client.invoke('skills', { provider: i.id, action });
							await load();
						},
						done
					);
				},
				primary
			);
			b.disabled = !canWrite();
			return b;
		};
		const actions = el('div', undefined, 'fl-actions');
		if (s.state === 'not_installed')
			actions.append(run('Install', 'install', true, 'Skills installed.'));
		if (s.state === 'update_available')
			actions.append(run('Update', 'install', true, 'Skills updated.'));
		if (s.state === 'installed' || s.state === 'update_available')
			actions.append(run('Remove', 'remove', false, 'Skills removed.'));
		if (actions.childElementCount) row.append(actions);
		return row;
	}
	function technicalDetails(i: IntegrationStatus) {
		const details = el('details', undefined, 'fl-technical fl-tool');
		details.append(el('summary', 'Technical details'));
		const list = el('dl');
		for (const [term, value] of [
			['Tool', i.cli],
			['Path', i.path ?? 'Not found'],
			[
				'Installed version',
				i.tool.state === 'installed'
					? i.tool.version
					: i.tool.state === 'not_installed'
						? 'Not installed'
						: 'Unknown'
			],
			[
				'Latest version',
				i.latest_version ??
					(i.self_updating && i.checked_at && i.tool.state === 'installed'
						? i.update_available
							? 'A newer build is available'
							: 'Same as installed'
						: 'Unknown')
			],
			['Last checked', i.checked_at ? new Date(i.checked_at).toLocaleString() : 'Not checked'],
			...(i.skills
				? [
						[
							'Skills',
							`${i.skills.source}${i.skills.commit ? ` @ ${i.skills.commit.slice(0, 7)} (${i.skills.count})` : ''}`
						]
					]
				: []),
			['Falcon Link version', PLUGIN_VERSION]
		]) {
			list.append(el('dt', term), el('dd', value));
		}
		details.append(list);
		return details;
	}
	function accountCard(a: Account, integration: IntegrationStatus) {
		const card = el('section', undefined, 'fl-card fl-account');
		const identity = el('div', undefined, 'fl-account-identity');
		const avatar = el(
			'span',
			(a.email ?? a.owner?.name ?? '?').slice(0, 1).toUpperCase(),
			'fl-account-avatar'
		);
		avatar.setAttribute('aria-hidden', 'true');
		const accountName = el('div', undefined, 'fl-account-name');
		const ui = uiOf(a.provider);
		accountName.append(el('h4', ui.title?.(a) ?? a.email ?? `${ui.name} account`));
		const meta = el('div', undefined, 'fl-account-meta');
		meta.append(el('span', a.owner ? `Owner: ${a.owner.name}` : 'No owner chosen'));
		if (a.purpose)
			meta.append(
				el(
					'span',
					a.purpose.kind === 'other'
						? a.purpose.label
						: a.purpose.kind === 'work'
							? 'Work'
							: 'Personal',
					'fl-account-purpose'
				)
			);
		for (const tag of ui.tags?.(a) ?? []) {
			const t = el('span', tag.label, 'fl-account-purpose');
			t.title = tag.note;
			meta.append(t);
		}
		accountName.append(meta);
		const word = accountWord(a);
		identity.append(avatar, accountName);
		if (word !== 'Connected')
			identity.append(
				el(
					'span',
					word,
					`fl-account-status${word === 'Signing in…' ? '' : ' fl-account-status-warn'}`
				)
			);
		card.append(identity);
		const access = accessSummary(a, status!.catalogs[a.provider]);
		const notes = (ui.tags?.(a) ?? []).map((t) => el('p', t.note, 'fl-muted'));
		const body = el('div', undefined, 'fl-account-access');
		if (access) {
			body.append(el('h5', access.title));
			if (access.items.length) {
				const capabilities = el('ul', undefined, 'fl-access-list');
				for (const capability of access.items) capabilities.append(el('li', capability));
				body.append(capabilities);
			}
			if (access.note) body.append(el('p', access.note, 'fl-muted'));
			body.append(...notes);
			card.append(body);
		}
		const checked = checks.get(a.id);
		if (checked && !checked.busy) {
			const result = el(
				'p',
				checked.error ?? 'Working — checked just now',
				`fl-account-result${checked.error ? ' fl-error' : ''}`
			);
			result.setAttribute('role', 'status');
			card.append(result);
		} else if (a.connection_error && word === 'Needs attention')
			card.append(el('p', a.connection_error.message, 'fl-error fl-account-error'));
		const footer = el('div', undefined, 'fl-account-footer');
		const primary = el('div', undefined, 'fl-actions');
		const retryWith = retryInput(a);
		const remove = button('Remove account', () => {
			closeForm();
			const confirm = el('div', undefined, 'fl-card-form');
			const title = el('h5', `Remove ${a.email ?? 'this account'}?`);
			confirm.append(
				title,
				el(
					'p',
					'This removes this account’s saved sign-in from this computer and removes it from this list. Other accounts are unchanged.'
				)
			);
			if (ui.revoke) confirm.append(revokeSentence(ui.revoke(a)));
			const note = ui.remove_note?.(a);
			if (note) confirm.append(el('p', note, 'fl-muted'));
			const yes = button('Remove account', async () => {
				await act(yes, async () => {
					await client.invoke('remove', { account_id: a.id });
					closeForm();
					await load();
				});
			});
			yes.disabled = !canWrite();
			const actions = el('div', undefined, 'fl-actions');
			actions.append(yes, button('Cancel', closeForm));
			confirm.append(actions);
			openInCard(a, confirm, title);
		});
		remove.disabled = !canWrite();
		if (word === 'Needs attention' || word === 'Not connected') {
			const retry = button(
				'Try again',
				async () => {
					if (a.auth === 'service_key') return keyForm(a);
					if (!retryWith) return accountForm(a);
					await act(retry, async () => startSignIn(retryWith));
				},
				true
			);
			retry.disabled = !canWrite() || !ready(integration) || signingIn(a);
			primary.append(retry);
		}
		const change = button(a.auth === 'service_key' ? 'Replace key' : 'Change access', () =>
			a.auth === 'service_key' ? keyForm(a) : accountForm(a)
		);
		change.disabled = !canWrite() || !ready(integration) || signingIn(a);
		primary.append(change);
		// Records left disconnected by an earlier version show Remove next to Try again.
		if (a.state === 'disconnected') primary.append(remove);
		footer.append(primary);
		const actions = el('div', undefined, 'fl-actions');
		const edit = button('Edit details', () => accountForm(a, true));
		edit.disabled = !canWrite();
		actions.append(edit);
		const check = button(checked?.busy ? 'Checking…' : 'Check connection', async () => {
			checks.set(a.id, { busy: true });
			render();
			try {
				await client.invoke('check', { account_id: a.id });
				checks.set(a.id, { busy: false });
			} catch (e) {
				checks.set(a.id, {
					busy: false,
					error: (e as Error).message || 'The connection check failed.'
				});
			}
			if (disposed) return;
			await load();
			render();
		});
		check.disabled =
			!canWrite() ||
			!(a.email || a.provider_id || a.external) ||
			a.state === 'disconnected' ||
			!!checked?.busy;
		if (checked?.busy) check.setAttribute('aria-busy', 'true');
		actions.append(check);
		if (a.state !== 'disconnected') actions.append(remove);
		const manage = el('details', undefined, 'fl-account-manage');
		manage.open = managing.has(a.id);
		manage.addEventListener('toggle', () => {
			if (manage.open) managing.add(a.id);
			else managing.delete(a.id);
		});
		manage.append(el('summary', 'Manage account'), actions);
		footer.append(manage);
		card.append(cardForm?.account === a.id ? cardForm.node : footer);
		return card;
	}
	function render() {
		if (disposed) return;
		const focused =
			formHost.contains(document.activeElement) || cardForm?.node.contains(document.activeElement)
				? (document.activeElement as HTMLElement)
				: null;
		layout.classList.toggle('fl-show-detail', selected !== null);
		nav.replaceChildren(el('h2', 'Integrations', 'fl-nav-label'));
		for (const { id, name } of PROVIDER_UI) {
			const b = button('', () => navigate(id));
			b.className = `fl-integration${selected === id ? ' fl-selected' : ''}`;
			b.setAttribute('aria-current', selected === id ? 'page' : 'false');
			const count = accounts.filter((a) => a.provider === id).length;
			const label = el('span', undefined, 'fl-nav-copy');
			label.append(
				el('span', name, 'fl-integration-name'),
				el(
					'span',
					!status
						? 'Checking…'
						: count
							? `${count} account${count === 1 ? '' : 's'}`
							: 'No accounts',
					'fl-muted'
				)
			);
			b.append(mark(id), label);
			const attention = status ? attentionWord(id) : null;
			if (attention) {
				const dot = el('span', undefined, 'fl-dot fl-dot-warn');
				dot.setAttribute('role', 'img');
				dot.setAttribute('aria-label', attention);
				dot.title = attention;
				b.append(dot);
			}
			nav.append(b);
		}
		// Keep the active form node mounted across status refreshes so input and focus survive.
		detail.replaceChildren();
		if (!selected || !status) {
			if (!status) detail.append(el('p', 'Loading…'));
			return;
		}
		const integration = status.integrations.find((i) => i.id === selected);
		if (!integration) {
			detail.append(el('p', 'This integration is not available on this Office.'));
			return;
		}
		const back = button('← Integrations', () => navigate(null));
		back.classList.add('fl-back');
		const providerHeader = el('header', undefined, 'fl-provider-header');
		const identity = el('div', undefined, 'fl-provider-identity');
		identity.append(mark(integration.id, true), el('h2', integration.name));
		providerHeader.append(identity);
		detail.append(back, providerHeader);
		const notices = banners(integration);
		if (notices) detail.append(notices);
		const list = accounts.filter((a) => a.provider === selected);
		const accountHeading = el('div', undefined, 'fl-section-heading');
		accountHeading.append(el('h3', 'Accounts'));
		// Ways to add an account: sign-in, and a pasted key where the provider offers one.
		const add = () => {
			const ui = uiOf(integration.id);
			const ways = ui.key
				? [button(ui.connect, () => accountForm(), true), button(ui.key.action, () => keyForm())]
				: [button('Add account', () => accountForm())];
			for (const b of ways) b.disabled = !canWrite() || !ready(integration);
			const group = el('div', undefined, 'fl-actions');
			group.append(...ways);
			return ways.length > 1 ? group : ways[0];
		};
		// Integrations that keep one account per Office explain why there's no Add.
		const single = uiOf(integration.id).single_account;
		if (single && list.some((a) => a.state !== 'disconnected'))
			accountHeading.append(el('p', single, 'fl-muted fl-single-account'));
		else if (list.length) accountHeading.append(add());
		detail.append(accountHeading);
		if (!list.length) {
			const empty = el('section', undefined, 'fl-empty');
			const emptyMark = mark(integration.id, true);
			emptyMark.classList.add('fl-empty-mark');
			empty.append(emptyMark, el('h3', `No ${integration.name} accounts connected`), add());
			detail.append(empty);
		}
		for (const a of list) detail.append(accountCard(a, integration));
		if (activeLogin?.provider === selected) {
			const login = loginCard();
			if (login) detail.append(login);
		}
		const skills = skillsRow(integration);
		detail.append(formHost, ...(skills ? [skills] : []), technicalDetails(integration));
		if (focused) focused.focus({ preventScroll: true });
	}
	void loadOwners().then(() => {
		if (!disposed) void load();
	});
	render();
	return {
		update(next: ControlUiViewContext) {
			const id = next.props.integration;
			selected = typeof id === 'string' && PROVIDER_UI.some((p) => p.id === id) ? id : null;
			render();
		},
		dispose() {
			disposed = true;
			closePendingTab();
			clearTimeout(poll);
			formDisposer?.();
			root.remove();
		}
	};
}
export default defineControlUiPlugin({
	id: PLUGIN_ID,
	activate(host) {
		host.ui.registerPage({ id: 'link', label: 'Falcon Link', mount });
		host.ui.registerNavigation({
			id: 'link',
			label: 'Falcon Link',
			page: { id: 'link' },
			icon: 'link'
		});
	}
});
