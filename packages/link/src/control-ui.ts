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
import { accessSummary, type AccessGroup } from './access-summary.js';
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
// The provider's own sign-in action (its official artwork where it has one), opening the
// sign-in address in a new tab. Shown once Link has that address, never on the form before it.
function signInAction(provider: Provider, url: string) {
	const text = uiOf(provider).connect;
	const a = el('a');
	a.href = url;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	if (SIGN_IN_LOGO.has(provider)) {
		a.className = 'fl-btn fl-btn-provider';
		const logo = el('img');
		logo.src = svg(LOGOS[provider]);
		logo.alt = '';
		a.append(logo, el('span', text));
		return a;
	}
	if (!SIGN_IN_ART[provider]) {
		a.className = 'fl-btn fl-btn-primary';
		a.textContent = text;
		return a;
	}
	a.className = 'fl-signin';
	a.setAttribute('aria-label', text);
	const art = el('img');
	art.src = svg(SIGN_IN_ART[provider]);
	art.alt = '';
	a.append(art);
	return a;
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
	// A sign-in in progress is shown inside its account's card; nothing about an account appears
	// anywhere else on the page.
	let activeLogin: Login | null = null;
	let formDisposer: (() => void) | undefined;
	// Check connection results and open Manage sections stay with their card across refreshes.
	const checks = new Map<string, { busy: boolean; error?: string }>();
	const managing = new Set<string>();
	const accessOpen = new Set<string>();
	// An account's own form or confirmation opens inside its card, replacing the card's actions.
	let cardForm: { account: string; node: HTMLElement } | null = null;
	// A new account's form takes the place in the list where that account will appear.
	let pending: { provider: Provider; node: HTMLElement } | null = null;
	const message = (s: string, error = false) => {
		notification.textContent = s;
		notification.classList.toggle('fl-error', error);
	};
	const canWrite = () => host.connection.canWrite;
	// A form's own problems are shown in the form, next to what needs fixing.
	function formError() {
		const p = el('p', undefined, 'fl-form-error fl-error');
		p.setAttribute('role', 'alert');
		return p;
	}
	// The provider address is offered, not opened: a login belongs to its address, not to the tab
	// that opened it, so the person can paste it into another browser profile or device.
	function signInLink(provider: Provider, url: string) {
		const box = el('div', undefined, 'fl-sign-in');
		const text = uiOf(provider).connect;
		const open = signInAction(provider, url);
		const note = el(
			'p',
			`${text} opens a new tab in this browser profile. To sign in from a different browser profile or device, copy the link and open it there. This page keeps waiting.`,
			'fl-muted'
		);
		const copy = button('Copy link', async () => {
			try {
				await navigator.clipboard.writeText(url);
				copy.textContent = 'Copied';
				setTimeout(() => {
					copy.textContent = 'Copy link';
				}, 2000);
			} catch {
				note.textContent = `The link could not be copied. Right-click ${text} and choose “Copy link address”.`;
				note.className = 'fl-error';
			}
		});
		const actions = el('div', undefined, 'fl-sign-in-actions');
		actions.append(open, copy);
		box.append(actions, note);
		return box;
	}
	async function act<T>(
		b: HTMLButtonElement,
		action: () => Promise<T>,
		success?: string,
		error?: HTMLElement
	) {
		b.disabled = true;
		if (error) error.textContent = '';
		try {
			const r = await action();
			if (disposed) return;
			if (success) message(success);
			return r;
		} catch (e) {
			if (disposed) return;
			const text = (e as Error).message || 'The operation failed. Try again.';
			if (error) error.textContent = text;
			else message(text, true);
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
		if (cardForm || pending) {
			cardForm = null;
			pending = null;
			render();
		}
	}
	function openInCard(account: Account, node: HTMLElement, title: HTMLElement) {
		cardForm = { account: account.id, node };
		render();
		title.tabIndex = -1;
		title.focus();
	}
	function openAsNew(provider: Provider, node: HTMLElement, title: HTMLElement) {
		pending = { provider, node };
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
	// Sign-in never opens the provider by itself: the card offers the link to open or copy, so the
	// person can finish in another browser profile (or device) than the one showing the Office.
	async function startSignIn(input: StartInput) {
		if (input.account_id) checks.delete(input.account_id);
		const l = await client.invoke('start', input);
		if (disposed) return;
		activeLogin = l as Login;
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
		const form = el('form', undefined, account ? 'fl-form fl-card-form' : 'fl-form fl-card fl-new');
		const title = el(
			account ? 'h5' : 'h4',
			metadataOnly ? 'Owner and purpose' : account ? 'Change access' : `Add a ${ui.name} account`
		);
		form.append(title);
		const problem = formError();
		// Owner and purpose are details, saved without signing in; access changes ask for them
		// only when the account has none yet.
		const askMetadata = metadataOnly || !account?.owner || !account?.purpose;
		const meta = metadataFields(account?.owner ?? undefined, account?.purpose ?? undefined);
		if (askMetadata) form.append(...meta.nodes);
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
		// The form only collects choices. The provider's sign-in action comes on the next screen,
		// once Link has a sign-in address for it.
		const submit = el('button', metadataOnly ? 'Save' : 'Continue', 'fl-btn fl-btn-primary');
		submit.type = 'submit';
		submit.disabled = !canWrite();
		const actions = el('div', undefined, 'fl-actions fl-signin-row');
		if (!metadataOnly && ui.email_required)
			actions.append(field(`${ui.name} account address`, email));
		actions.append(submit, button('Cancel', closeForm));
		form.append(problem, actions);
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!form.reportValidity()) return;
			void act(
				submit,
				async () => {
					const values = askMetadata
						? meta.values()
						: { owner: account!.owner!, purpose: account!.purpose! };
					if (!values.owner) throw new Error('Choose an owner.');
					if (metadataOnly && account) {
						await client.invoke('metadata', { account_id: account.id, ...values });
						closeForm();
						await load();
						return;
					}
					const permissions = rows ? rows.selected() : [];
					if (rows && !permissions.length)
						throw new Error('Choose access for at least one service.');
					await startSignIn({
						provider,
						...values,
						permissions,
						...(account ? { account_id: account.id } : {}),
						...(ui.email_required ? { email: email.value.trim() } : {})
					});
				},
				undefined,
				problem
			);
		});
		if (account) openInCard(account, form, title);
		else openAsNew(provider, form, title);
	}
	// Connects with a pasted service key instead of a sign-in; the key is sent once and never shown again.
	function keyForm(account?: Account) {
		if (!selected || !status) return;
		closeForm();
		const provider = selected;
		const ui = uiOf(provider);
		if (!ui.key) return;
		const form = el('form', undefined, account ? 'fl-form fl-card-form' : 'fl-form fl-card fl-new');
		const title = el(account ? 'h5' : 'h4', account ? 'Replace service key' : ui.key.action);
		form.append(title, el('p', ui.key.help, 'fl-muted'));
		const problem = formError();
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
		form.append(problem, actions);
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
				'Account connected.',
				problem
			);
		});
		if (account) openInCard(account, form, title);
		else openAsNew(provider, form, title);
	}
	function scheduleLogin() {
		clearTimeout(poll);
		if (disposed || !activeLogin || !ACTIVE.includes(activeLogin.state)) return;
		poll = setTimeout(async () => {
			try {
				const next = (await client.invoke('login', { id: activeLogin!.id })) as Login;
				if (disposed) return;
				const changed = JSON.stringify(next) !== JSON.stringify(activeLogin);
				settleLogin(next);
				if (changed) await load();
				scheduleLogin();
			} catch {
				if (!disposed)
					message('Sign-in status could not be refreshed. Refresh the page or try again.', true);
			}
		}, 2000);
	}
	// A finished sign-in leaves nothing of its own behind: the account's card already says
	// Connected or Needs attention (with the reason), and a cancelled new account is gone.
	function settleLogin(next: Login) {
		activeLogin = ACTIVE.includes(next.state) ? next : null;
		if (next.state === 'connected') message(next.message);
	}
	// The sign-in in progress, inside the account's card where its actions normally are.
	function loginPanel(login: Login) {
		const panel = el('div', undefined, 'fl-card-form fl-signing-in');
		panel.setAttribute('aria-live', 'polite');
		panel.append(
			el(
				'h5',
				login.step ? `Signing in — step ${login.step.number} of ${login.step.total}` : 'Signing in'
			),
			el('p', login.message)
		);
		const warning = login.state === 'verifying' ? null : pasteWarning(login.provider);
		if (warning) panel.append(warning);
		if (login.url) panel.append(signInLink(login.provider, login.url));
		if (login.code) panel.append(el('p', login.code, 'fl-device-code'));
		const problem = formError();
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
				void act(
					finish,
					async () => {
						const value = input.value;
						input.value = '';
						settleLogin(
							(await client.invoke('finish', { id: login.id, redirect: value })) as Login
						);
						if (!disposed) await load();
					},
					undefined,
					problem
				);
			});
			panel.append(form);
		}
		panel.append(problem);
		if (login.state !== 'verifying') {
			const cancel = button('Cancel sign-in', async () => {
				await act(
					cancel,
					async () => {
						settleLogin((await client.invoke('cancel', { id: login.id })) as Login);
						await load();
					},
					undefined,
					problem
				);
			});
			cancel.disabled = !canWrite();
			const actions = el('div', undefined, 'fl-actions');
			actions.append(cancel);
			panel.append(actions);
		}
		return panel;
	}
	const signingIn = (a: Account) =>
		activeLogin?.account_id === a.id && ACTIVE.includes(activeLogin.state);
	// One vocabulary wherever a status appears. Connected is the quiet default and is not shown.
	function accountWord(a: Account) {
		if (signingIn(a)) return 'Signing in…';
		if (a.state === 'connected' || a.state === 'discovered') return 'Connected';
		if (a.state === 'disconnected') return 'Signed out';
		return 'Needs attention';
	}
	function attentionWord(provider: Provider) {
		const words: string[] = accounts.filter((a) => a.provider === provider).map(accountWord);
		return ['Signed out', 'Needs attention'].find((w) => words.includes(w)) ?? null;
	}
	const ready = (i: IntegrationStatus) =>
		i.setup.state === 'ready' && i.tool.state !== 'not_installed' && !i.below_minimum;
	// Plain banners only when something needs doing; otherwise no plumbing is shown.
	function banners(i: IntegrationStatus) {
		const list = el('div', undefined, 'fl-banners');
		const add = (text: string, action?: HTMLButtonElement, lead?: string) => {
			const b = el('div', undefined, 'fl-banner');
			b.setAttribute('role', 'status');
			const p = el('p');
			if (lead) p.append(el('strong', lead), ' ');
			p.append(text);
			b.append(p);
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
		// A tool Link didn't install, which Link can install: one plain fix, with a warning
		// first when accounts will be signed out.
		const fixable =
			i.tool.state === 'installed' &&
			!i.managed &&
			i.installable &&
			(i.below_minimum || i.update_available);
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
		else if (fixable) {
			const fix = button('Fix it', () => confirmReinstall(i, fix), true);
			fix.disabled = !canWrite();
			add(
				`This ${i.name} connection was set up outside Falcon Link, so Link can't keep it up to date.`,
				fix,
				`${i.name} needs a quick fix.`
			);
		} else if (i.below_minimum)
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
	// Reinstalling over a tool Link didn't install signs out the accounts found in that tool's
	// own store. Say which, and ask, before doing it.
	function confirmReinstall(i: IntegrationStatus, trigger: HTMLButtonElement) {
		const affected = accounts.filter(
			(a) => a.provider === i.id && a.external && a.state !== 'disconnected'
		);
		const run = async (b: HTMLButtonElement) => {
			await act(b, async () => {
				const result = (await client.invoke('install', { provider: i.id, replace: true })) as {
					signed_out?: string[];
				};
				await load();
				const n = result?.signed_out?.length ?? 0;
				message(
					n
						? `${i.name} is up to date. ${n} account${n === 1 ? ' needs' : 's need'} you to sign in again.`
						: `${i.name} is up to date.`
				);
			});
		};
		if (!affected.length) return void run(trigger);
		const dialog = el('dialog', undefined, 'fl-dialog');
		dialog.setAttribute('role', 'alertdialog');
		const title = el(
			'h3',
			affected.length === 1
				? `Reconnect this ${i.name} account afterward?`
				: `Reconnect these ${i.name} accounts afterward?`
		);
		title.id = `fl-dialog-${Math.random().toString(36).slice(2)}`;
		dialog.setAttribute('aria-labelledby', title.id);
		const names = el('ul', undefined, 'fl-dialog-accounts');
		for (const a of affected)
			names.append(el('li', uiOf(a.provider).title?.(a) ?? a.email ?? `${i.name} account`));
		const close = () => {
			if (typeof dialog.close === 'function' && dialog.open) dialog.close();
			dialog.remove();
		};
		const confirm = button(
			'Fix and sign out',
			async () => {
				close();
				await run(trigger);
			},
			true
		);
		confirm.classList.add('fl-btn-danger');
		const actions = el('div', undefined, 'fl-actions');
		const cancel = button('Cancel', close);
		actions.append(cancel, confirm);
		dialog.append(
			title,
			el(
				'p',
				affected.length === 1
					? 'Fixing this signs out this account:'
					: 'Fixing this signs out these accounts:'
			),
			names,
			el(
				'p',
				affected.length === 1
					? "You'll need to sign in to it again. It takes about a minute."
					: "You'll need to sign in to each one again. It takes about a minute per account."
			),
			actions
		);
		dialog.addEventListener('cancel', () => dialog.remove());
		root.append(dialog);
		if (typeof dialog.showModal === 'function') dialog.showModal();
		else dialog.setAttribute('open', '');
		cancel.focus();
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
	// Access reads as one row per service. A long list shows its services on one line and
	// opens to the full rows.
	function accessList(a: Account, groups: AccessGroup[]) {
		if (!groups.length) return null;
		const named = groups.every((g) => g.service);
		const rows = () => {
			if (!named) {
				const list = el('ul', undefined, 'fl-access-list');
				for (const item of groups.flatMap((g) => g.items)) list.append(el('li', item));
				return list;
			}
			const list = el('dl', undefined, 'fl-access-rows');
			for (const g of groups) list.append(el('dt', g.service!), el('dd', g.items.join(', ')));
			return list;
		};
		const labels = named ? groups.map((g) => g.service!) : groups.flatMap((g) => g.items);
		const shown = named ? 5 : 3;
		if (labels.length <= shown) return rows();
		const details = el('details', undefined, 'fl-access');
		details.open = accessOpen.has(a.id);
		const summary = el('summary');
		const more = labels.length - shown;
		const preview = el('span', `${labels.slice(0, shown).join(' · ')}`, 'fl-access-preview');
		const extra = el('span', `+${more} more`, 'fl-access-more');
		const toggle = el('span', details.open ? 'Show less' : 'Show all', 'fl-access-toggle');
		summary.append(preview, extra, toggle);
		details.append(summary, rows());
		details.addEventListener('toggle', () => {
			if (details.open) accessOpen.add(a.id);
			else accessOpen.delete(a.id);
			toggle.textContent = details.open ? 'Show less' : 'Show all';
		});
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
		// Owner and purpose change here and save without signing in again.
		const details = button('', () => accountForm(a, true));
		details.className = 'fl-account-details';
		details.disabled = !canWrite();
		details.setAttribute('aria-label', 'Change owner and purpose');
		details.append(el('span', a.owner ? `Owner: ${a.owner.name}` : 'No owner chosen'));
		if (a.purpose)
			details.append(
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
		details.append(
			el('span', a.owner && a.purpose ? 'Change' : 'Choose', 'fl-account-details-action')
		);
		meta.append(details);
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
					`fl-account-status${
						word === 'Signing in…'
							? ''
							: word === 'Signed out'
								? ' fl-account-status-error'
								: ' fl-account-status-warn'
					}`
				)
			);
		card.append(identity);
		const access = accessSummary(a, status!.catalogs[a.provider]);
		const notes = (ui.tags?.(a) ?? []).map((t) => el('p', t.note, 'fl-muted'));
		const body = el('div', undefined, 'fl-account-access');
		if (access) {
			body.append(el('h5', access.title));
			const list = accessList(a, access.groups);
			if (list) body.append(list);
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
		} else if (a.connection_error && (word === 'Needs attention' || word === 'Signed out'))
			card.append(el('p', a.connection_error.message, 'fl-error fl-account-error'));
		else if (word === 'Signed out')
			card.append(
				el('p', 'Sign in again so your agents can use this account.', 'fl-error fl-account-error')
			);
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
		if (word === 'Needs attention' || word === 'Signed out') {
			const retry = button(
				word === 'Signed out' ? 'Sign in again' : 'Try again',
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
		// A signed-out account has one next step: Sign in again.
		if (word !== 'Signed out') {
			const change = button(a.auth === 'service_key' ? 'Replace key' : 'Change access', () =>
				a.auth === 'service_key' ? keyForm(a) : accountForm(a)
			);
			change.disabled = !canWrite() || !ready(integration) || signingIn(a);
			primary.append(change);
		}
		// Records left disconnected by an earlier version show Remove next to Try again.
		if (a.state === 'disconnected') primary.append(remove);
		footer.append(primary);
		const actions = el('div', undefined, 'fl-actions');
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
		// While signing in, the card's actions give way to the sign-in itself.
		card.append(
			signingIn(a) ? loginPanel(activeLogin!) : cardForm?.account === a.id ? cardForm.node : footer
		);
		return card;
	}
	function render() {
		if (disposed) return;
		const focused =
			pending?.node.contains(document.activeElement) ||
			cardForm?.node.contains(document.activeElement)
				? (document.activeElement as HTMLElement)
				: null;
		layout.classList.toggle('fl-show-detail', selected !== null);
		nav.replaceChildren(el('h2', 'Integrations', 'fl-nav-label'));
		for (const { id, name } of PROVIDER_UI) {
			const b = button('', () => navigate(id));
			b.className = `fl-integration${selected === id ? ' fl-selected' : ''}`;
			b.setAttribute('aria-current', selected === id ? 'page' : 'false');
			const count = accounts.filter((a) => a.provider === id).length;
			const signedOut = accounts.filter(
				(a) => a.provider === id && accountWord(a) === 'Signed out'
			).length;
			const label = el('span', undefined, 'fl-nav-copy');
			label.append(
				el('span', name, 'fl-integration-name'),
				el(
					'span',
					!status
						? 'Checking…'
						: signedOut
							? `${signedOut} need${signedOut === 1 ? 's' : ''} sign-in`
							: count
								? `${count} account${count === 1 ? '' : 's'}`
								: 'No accounts',
					'fl-muted'
				)
			);
			b.append(mark(id), label);
			const attention = status ? attentionWord(id) : null;
			if (attention) {
				const dot = el(
					'span',
					undefined,
					`fl-dot ${attention === 'Signed out' ? 'fl-dot-error' : 'fl-dot-warn'}`
				);
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
		const adding = pending?.provider === selected ? pending.node : null;
		if (single && list.some((a) => a.state !== 'disconnected'))
			accountHeading.append(el('p', single, 'fl-muted fl-single-account'));
		else if (list.length && !adding) accountHeading.append(add());
		detail.append(accountHeading);
		if (!list.length && !adding) {
			const empty = el('section', undefined, 'fl-empty');
			const emptyMark = mark(integration.id, true);
			emptyMark.classList.add('fl-empty-mark');
			empty.append(emptyMark, el('h3', `No ${integration.name} accounts connected`), add());
			detail.append(empty);
		}
		for (const a of list) detail.append(accountCard(a, integration));
		// The new account's form sits where its card will appear once it is signing in.
		if (adding) detail.append(adding);
		const skills = skillsRow(integration);
		detail.append(...(skills ? [skills] : []), technicalDetails(integration));
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
