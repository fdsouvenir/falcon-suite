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
// Official provider artwork, unmodified (see assets/brand/README.md).
import googleSignIn from '../assets/brand/google-signin-light-square.svg' with { type: 'text' };
import microsoftSignIn from '../assets/brand/microsoft-signin-light.svg' with { type: 'text' };
import microsoftLogo from '../assets/brand/microsoft-logo.svg' with { type: 'text' };

const svg = (source: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
const NAMES: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft' };
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
	const node = el('span', provider === 'google' ? 'G' : undefined, cls);
	if (provider === 'microsoft') {
		const logo = el('img');
		logo.src = svg(microsoftLogo);
		logo.alt = '';
		node.append(logo);
	}
	node.setAttribute('aria-hidden', 'true');
	return node;
}
// The provider's sign-in artwork is the action that starts sign-in.
function signInButton(provider: Provider) {
	const text = `Sign in with ${NAMES[provider]}`;
	const b = el('button', undefined, 'fl-signin');
	b.type = 'submit';
	b.setAttribute('aria-label', text);
	const art = el('img');
	art.src = svg(provider === 'google' ? googleSignIn : microsoftSignIn);
	art.alt = '';
	b.append(art);
	return b;
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
		el(
			'p',
			'Connect your Google and Microsoft accounts so your assistant can help with email, calendar and files.',
			'fl-page-description'
		)
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
	const footer = el('footer', `Falcon Link ${PLUGIN_VERSION}`, 'fl-footer');
	root.append(header, notification, layout, footer);
	container.append(root);
	let selected: Provider | null =
		(context.props.integration as Provider) ||
		(window.matchMedia('(max-width: 700px)').matches ? null : 'google');
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
		technical.append(el('summary', 'Technical details'), scopeList);
		const update = () => {
			try {
				scopeList.textContent = selectionScopes(
					provider,
					catalog,
					pickers.flatMap((p) => p())
				).join('\n');
			} catch {
				scopeList.textContent = 'Choose access for at least one service.';
			}
		};
		const initial = new Set(offeredSelection(provider, catalog, saved));
		let more: HTMLElement | null = null;
		for (const row of catalog.rows) {
			const line = el('div', undefined, 'fl-permission');
			const copy = el('div', undefined, 'fl-permission-copy');
			const description = el('p', '', 'fl-muted');
			const choice = select(
				[{ value: '', label: 'Off' }, ...row.levels.map((l) => ({ value: l.id, label: l.label }))],
				row.levels.find((l) => initial.has(l.id))?.id ?? ''
			);
			const describe = () => {
				description.textContent = row.levels.find((l) => l.id === choice.value)?.description ?? '';
			};
			choice.addEventListener('change', () => {
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
			}
			const level = row.levels.length ? choice : null;
			const extra = row.addon ? { id: row.addon.id, input: addon! } : null;
			pickers.push(() => [
				...(level?.value ? [level.value] : []),
				...(extra?.input.checked ? [extra.id] : [])
			]);
			line.append(copy, controls);
			if (row.group === 'more') {
				if (!more) {
					const group = el('details', undefined, 'fl-more');
					group.append(el('summary', `More ${NAMES[provider]} services`));
					more = el('div');
					group.append(more);
					node.append(group);
				}
				more.append(line);
			} else node.append(line);
		}
		node.append(technical);
		update();
		return { node, selected: () => pickers.flatMap((p) => p()) };
	}
	// Where a person removes access they already gave, by provider and account type.
	function revokeSentence(account: Account) {
		const p = el('p', "To remove access you've already given, use ", 'fl-muted');
		if (account.provider === 'google')
			p.append(link("Google's app-access page", 'https://myaccount.google.com/connections'), '.');
		else if (account.audience === 'consumer')
			p.append(link("Microsoft's app-access page", 'https://account.live.com/consent/Manage'), '.');
		else if (account.audience === 'enterprise')
			p.append(link("Microsoft's app-access page", 'https://myapplications.microsoft.com/'), '.');
		else
			p.append(
				"Microsoft's app-access page for ",
				link('personal accounts', 'https://account.live.com/consent/Manage'),
				' or ',
				link('work or school accounts', 'https://myapplications.microsoft.com/'),
				'.'
			);
		return p;
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
		if (!a.owner || !a.purpose || !a.requested.length) return null;
		if (a.provider === 'google' && !a.email) return null;
		return {
			provider: a.provider,
			owner: a.owner,
			purpose: a.purpose,
			permissions: a.requested,
			account_id: a.id,
			...(a.provider === 'google' ? { email: a.email! } : {})
		};
	}
	function accountForm(account?: Account, metadataOnly = false) {
		if (!selected || !status) return;
		closeForm();
		const provider = selected;
		const form = el('form', undefined, 'fl-form');
		const title = el(
			'h3',
			metadataOnly
				? 'Account details'
				: account
					? 'Change access'
					: `Add a ${NAMES[provider]} account`
		);
		form.append(title);
		const meta = metadataFields(account?.owner ?? undefined, account?.purpose ?? undefined);
		form.append(...meta.nodes);
		const rows = metadataOnly ? null : permissionRows(provider, account?.requested ?? []);
		const email = el('input');
		email.type = 'email';
		email.maxLength = 254;
		email.value = account?.email ?? '';
		email.required = provider === 'google' && !metadataOnly;
		email.readOnly = !!account?.email && provider === 'google';
		email.autocomplete = 'email';
		if (rows) {
			form.append(rows.node);
			if (account) form.append(revokeSentence(account));
		}
		const submit = metadataOnly
			? el('button', 'Save details', 'fl-btn fl-btn-primary')
			: signInButton(provider);
		submit.type = 'submit';
		submit.disabled = !canWrite();
		const actions = el('div', undefined, 'fl-actions fl-signin-row');
		if (rows && provider === 'google') actions.append(field('Google account address', email));
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
				const permissions = rows!.selected();
				if (!permissions.length) throw new Error('Choose access for at least one service.');
				await startSignIn({
					provider,
					...values,
					permissions,
					...(account ? { account_id: account.id } : {}),
					...(provider === 'google' ? { email: email.value.trim() } : {})
				});
			});
		});
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
			card.append(el('h3', 'Signing in…'), el('p', login.message));
			if (login.url) {
				card.append(
					el(
						'p',
						signInOpened
							? 'Sign-in opened in a new tab.'
							: 'Your browser may have blocked the sign-in tab. Open sign-in to continue.',
						'fl-muted'
					)
				);
				const a = link(signInOpened ? 'Reopen sign-in' : 'Open sign-in', login.url);
				a.className = 'fl-btn';
				card.append(a);
			}
			if (login.code) card.append(el('p', login.code, 'fl-device-code'));
			if (
				login.url &&
				!login.hosted &&
				login.provider === 'google' &&
				login.state === 'awaiting_consent'
			) {
				const form = el('form', undefined, 'fl-paste');
				const input = el('input');
				input.type = 'url';
				input.required = true;
				input.maxLength = 8192;
				input.autocomplete = 'off';
				const finish = el('button', 'Continue', 'fl-btn fl-btn-primary');
				finish.type = 'submit';
				finish.disabled = !canWrite();
				form.append(field('Address shown in your browser after signing in', input), finish);
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
	// One vocabulary for the sidebar, the badge and each account.
	function accountWord(a: Account) {
		if (signingIn(a)) return 'Signing in…';
		if (a.state === 'connected' || a.state === 'discovered') return 'Connected';
		if (a.state === 'disconnected') return 'Not connected';
		return 'Needs attention';
	}
	function providerWord(provider: Provider) {
		const words: string[] = accounts.filter((a) => a.provider === provider).map(accountWord);
		if (activeLogin?.provider === provider && ACTIVE.includes(activeLogin.state))
			return 'Signing in…';
		return (
			['Signing in…', 'Needs attention', 'Connected'].find((w) => words.includes(w)) ??
			'Not connected'
		);
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
		if (i.tool.state === 'not_installed')
			add(
				i.installable
					? `Install ${i.cli} to connect ${i.name} accounts.`
					: `Install ${i.cli} on this computer to connect ${i.name} accounts. Link installs it automatically on Linux.`,
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
			['Latest version', i.latest_version ?? 'Unknown'],
			['Last checked', i.checked_at ? new Date(i.checked_at).toLocaleString() : 'Not checked']
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
		accountName.append(el('h4', a.email ?? `${NAMES[a.provider]} account`));
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
		accountName.append(meta);
		const word = accountWord(a);
		identity.append(
			avatar,
			accountName,
			el(
				'span',
				word,
				`fl-account-status${word === 'Connected' ? ' fl-account-status-ok' : word === 'Needs attention' ? ' fl-account-status-warn' : ''}`
			)
		);
		card.append(identity);
		const access = accessSummary(a, status!.catalogs[a.provider]);
		const body = el('div', undefined, 'fl-account-access');
		if (access) {
			body.append(el('h5', access.title));
			if (access.items.length) {
				const capabilities = el('ul', undefined, 'fl-access-list');
				for (const capability of access.items) capabilities.append(el('li', capability));
				body.append(capabilities);
			}
			if (access.note) body.append(el('p', access.note, 'fl-muted'));
			card.append(body);
		}
		if (a.connection_error && word === 'Needs attention')
			card.append(el('p', a.connection_error.message, 'fl-error fl-account-error'));
		const footer = el('div', undefined, 'fl-account-footer');
		const primary = el('div', undefined, 'fl-actions');
		const retryWith = retryInput(a);
		if (word === 'Needs attention' || word === 'Not connected') {
			const retry = button(
				'Try again',
				async () => {
					if (!retryWith) return accountForm(a);
					await act(retry, async () => startSignIn(retryWith));
				},
				true
			);
			retry.disabled = !canWrite() || !ready(integration) || signingIn(a);
			primary.append(retry);
		}
		const change = button('Change access', () => accountForm(a));
		change.disabled = !canWrite() || !ready(integration) || signingIn(a);
		primary.append(change);
		footer.append(primary);
		const actions = el('div', undefined, 'fl-actions');
		const edit = button('Edit details', () => accountForm(a, true));
		edit.disabled = !canWrite();
		actions.append(edit);
		const check = button('Check connection', async () => {
			await act(
				check,
				async () => {
					await client.invoke('check', { account_id: a.id });
					await load();
				},
				'Connection checked.'
			);
		});
		check.disabled = !canWrite() || !a.email || a.state === 'disconnected';
		actions.append(check);
		if (a.state !== 'disconnected') {
			const disconnect = button('Disconnect', () => {
				closeForm();
				const confirm = el('section', undefined, 'fl-card');
				confirm.append(
					el('h3', `Disconnect ${a.email ?? 'this account'}?`),
					el(
						'p',
						'This removes this account’s saved sign-in from this computer. Other accounts are unchanged.'
					),
					revokeSentence(a)
				);
				const yes = button('Disconnect account', async () => {
					await act(yes, async () => {
						await client.invoke('disconnect', { account_id: a.id });
						closeForm();
						await load();
					});
				});
				yes.disabled = !canWrite();
				confirm.append(yes, button('Cancel', closeForm));
				formHost.append(confirm);
			});
			disconnect.disabled = !canWrite();
			actions.append(disconnect);
		}
		const manage = el('details', undefined, 'fl-account-manage');
		manage.append(el('summary', 'Manage account'), actions);
		footer.append(manage);
		card.append(footer);
		return card;
	}
	function render() {
		if (disposed) return;
		const focused = formHost.contains(document.activeElement)
			? (document.activeElement as HTMLElement)
			: null;
		layout.classList.toggle('fl-show-detail', selected !== null);
		nav.replaceChildren(el('h2', 'Integrations', 'fl-nav-label'));
		for (const id of ['google', 'microsoft'] as Provider[]) {
			const b = button('', () => navigate(id));
			b.className = `fl-integration${selected === id ? ' fl-selected' : ''}`;
			b.setAttribute('aria-current', selected === id ? 'page' : 'false');
			const word = status ? providerWord(id) : 'Checking…';
			const label = el('span', undefined, 'fl-nav-copy');
			label.append(el('span', NAMES[id], 'fl-integration-name'), el('span', word, 'fl-muted'));
			const dot = el(
				'span',
				undefined,
				`fl-dot${word === 'Connected' ? ' fl-dot-ok' : word === 'Needs attention' ? ' fl-dot-warn' : ''}`
			);
			dot.setAttribute('aria-hidden', 'true');
			b.append(mark(id), label, dot);
			nav.append(b);
		}
		// Keep the active form node mounted across status refreshes so input and focus survive.
		detail.replaceChildren();
		if (!selected || !status) {
			if (!status) detail.append(el('p', 'Loading…'));
			return;
		}
		const integration = status.integrations.find((i) => i.id === selected)!;
		const back = button('← Integrations', () => navigate(null));
		back.classList.add('fl-back');
		const providerHeader = el('header', undefined, 'fl-provider-header');
		const identity = el('div', undefined, 'fl-provider-identity');
		identity.append(mark(integration.id, true), el('h2', integration.name));
		const word = providerWord(integration.id);
		providerHeader.append(
			identity,
			el('span', word, `fl-badge${word === 'Connected' ? ' fl-badge-ok' : ''}`)
		);
		detail.append(back, providerHeader);
		const notices = banners(integration);
		if (notices) detail.append(notices);
		const list = accounts.filter((a) => a.provider === selected);
		const accountHeading = el('div', undefined, 'fl-section-heading');
		accountHeading.append(el('h3', 'Accounts'));
		const add = () => {
			const b = button('Add account', () => accountForm());
			b.disabled = !canWrite() || !ready(integration);
			return b;
		};
		if (list.length) accountHeading.append(add());
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
		detail.append(formHost, technicalDetails(integration));
		if (focused) focused.focus({ preventScroll: true });
	}
	void loadOwners().then(() => {
		if (!disposed) void load();
	});
	render();
	return {
		update(next: ControlUiViewContext) {
			const id = next.props.integration;
			selected = id === 'google' || id === 'microsoft' ? id : null;
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
