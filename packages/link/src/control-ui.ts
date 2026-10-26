import { defineControlUiPlugin, type ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from './contract.js';
import { PLUGIN_ID, PLUGIN_VERSION } from './identity.js';
import type { Overview, ToolStatus } from './status.js';
import {
	type Account,
	type Owner,
	type Purpose,
	type Provider,
	type Permission,
	requestedScopes
} from './model.js';
import './control-ui.css';
import { accessSummary } from './access-summary.js';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
	const n = document.createElement(tag);
	if (text !== undefined) n.textContent = text;
	if (cls) n.className = cls;
	return n;
}
const toolLabel = (t: ToolStatus) =>
	t.state === 'installed'
		? `Installed · ${t.version}`
		: {
				not_installed: 'Not installed',
				check_failed: 'Version check failed — status unknown',
				unrecognized_version: 'Version not recognized'
			}[t.state];
function button(text: string, action: () => void | Promise<void>, primary = false) {
	const b = el('button', text, `fl-btn${primary ? ' fl-btn-primary' : ''}`);
	b.type = 'button';
	b.addEventListener('click', () => void action());
	return b;
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
function mount(container: HTMLElement, context: ControlUiViewContext) {
	const host = context.host;
	const client = createFeatureClient(contract, host);
	const root = el('section', undefined, 'fl-page');
	const header = el('header', undefined, 'fl-header');
	const version = PLUGIN_VERSION.includes('-')
		? PLUGIN_VERSION.split('-').slice(1).join('-')
		: PLUGIN_VERSION;
	const title = el('h1', 'Falcon Link');
	title.append(el('span', ` v${version}`, 'fl-version'));
	const heading = el('div');
	heading.append(
		title,
		el('p', "Control your Agents' access to third party accounts.", 'fl-page-description')
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
		(window.matchMedia('(max-width: 700px)').matches ? null : 'google');
	let status:
		| (Overview & {
				permissions: Record<Provider, Permission[]>;
				baseline_scopes: Record<Provider, string[]>;
		  })
		| null = null;
	let accounts: Account[] = [];
	let owners: Owner[] = [];
	let disposed = false;
	let refreshing = false;
	let poll: ReturnType<typeof setTimeout> | undefined;
	let activeLogin: {
		provider: Provider;
		id: string;
		account_id: string;
		state: string;
		message: string;
		url: string | null;
		code: string | null;
		expires_at: string;
		hosted?: boolean;
	} | null = null;
	// Reserve the tab during the submit gesture; async provider setup can outlive popup permission.
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
		const [humans, agents] = await Promise.allSettled([
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
			}>('agents.list', {})
		]);
		if (disposed) return;
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
			message(
				'Some OpenClaw profiles could not be loaded. Only available profiles can be selected.',
				true
			);
	}
	function metadataFields(owner?: Owner, purpose?: Purpose) {
		const choices = [
			{ value: '', label: 'Choose an owner' },
			...owners.map((o) => ({
				value: `${o.kind}:${o.id}`,
				label: `${o.name} · ${o.kind === 'agent' ? 'Agent' : 'Human'}`
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
	function accountForm(account?: Account, metadataOnly = false) {
		if (!selected || !status) return;
		closeForm();
		const provider = selected;
		const form = el('form', undefined, 'fl-form');
		const heading = el(
			'h3',
			metadataOnly
				? 'Account details'
				: account
					? 'Reconnect / change permissions'
					: 'Connect account'
		);
		form.append(heading);
		const meta = metadataFields(account?.owner ?? undefined, account?.purpose ?? undefined);
		form.append(...meta.nodes);
		const email = el('input');
		email.type = 'email';
		email.maxLength = 254;
		email.value = account?.email ?? '';
		email.required = provider === 'google';
		email.readOnly = !!account?.email && provider === 'google';
		const audience = select([
			{ value: 'consumer', label: 'Personal Microsoft account' },
			{ value: 'enterprise', label: 'Work or school account' }
		]);
		const permissions = el('fieldset');
		permissions.append(el('legend', 'Connection permissions'));
		const chosen = new Set(account?.requested ?? []);
		const scopes = el('div', undefined, 'fl-scopes');
		const review = () => {
			scopes.replaceChildren(el('strong', 'Provider permissions to request'));
			try {
				scopes.append(el('p', requestedScopes(provider, [...chosen]).join('\n')));
			} catch {
				scopes.append(el('p', 'Select at least one permission. Nothing is preselected.'));
			}
		};
		for (const p of status.permissions[provider]) {
			const check = el('input');
			check.type = 'checkbox';
			check.value = p.id;
			check.checked = chosen.has(p.id);
			check.addEventListener('change', () => {
				if (check.checked) chosen.add(p.id);
				else chosen.delete(p.id);
				review();
			});
			const label = el('label', undefined, 'fl-check');
			label.append(check, el('span', p.label));
			permissions.append(label);
		}
		review();
		if (!metadataOnly) {
			form.append(
				provider === 'google'
					? field('Google account address', email)
					: field('Microsoft account type', audience),
				permissions,
				scopes
			);
			form.append(
				el(
					'p',
					'Requested permissions are not verified grants. Provider consent, tenant policy, and your operating instructions remain separate.',
					'fl-muted'
				)
			);
			if (account)
				form.append(
					el(
						'p',
						'Changing these selections does not revoke earlier provider consent. For narrower access, revoke the app at the provider and sign in again.',
						'fl-muted'
					)
				);
		}
		const submit = el(
			'button',
			metadataOnly ? 'Save details' : 'Continue to sign-in',
			'fl-btn fl-btn-primary'
		);
		submit.type = 'submit';
		submit.disabled = !canWrite();
		const actions = el('div', undefined, 'fl-actions');
		actions.append(submit, button('Cancel', closeForm));
		form.append(actions);
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!form.reportValidity()) return;
			void act(submit, async () => {
				const values = meta.values();
				if (!values.owner) throw new Error('Choose an existing human or agent.');
				if (metadataOnly && account) {
					await client.invoke('metadata', { account_id: account.id, ...values });
					closeForm();
					await load();
					return;
				}
				if (!chosen.size) throw new Error('Select at least one connection permission.');
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
					const l = await client.invoke('start', {
						provider,
						...values,
						permissions: [...chosen],
						...(account ? { account_id: account.id } : {}),
						...(provider === 'google'
							? { email: email.value.trim() }
							: { audience: audience.value as 'consumer' | 'enterprise' })
					});
					if (disposed) {
						closePendingTab();
						return;
					}
					activeLogin = l as typeof activeLogin;
					followSignIn();
				} catch (error) {
					closePendingTab();
					throw error;
				}
				closeForm();
				render();
				scheduleLogin();
			});
		});
		formHost.append(form);
		heading.tabIndex = -1;
		heading.focus();
	}
	function scheduleLogin() {
		clearTimeout(poll);
		if (
			disposed ||
			!activeLogin ||
			!['starting', 'awaiting_consent', 'verifying'].includes(activeLogin.state)
		)
			return;
		poll = setTimeout(async () => {
			try {
				const l = await client.invoke('login', { id: activeLogin!.id });
				if (disposed) return;
				const next = l as typeof activeLogin;
				const changed = JSON.stringify(next) !== JSON.stringify(activeLogin);
				activeLogin = next;
				followSignIn();
				if (changed) render();
				if (activeLogin?.state === 'connected') await load();
				scheduleLogin();
			} catch {
				if (!disposed)
					message(
						'Sign-in status could not be refreshed. Refresh the page or start a new sign-in.',
						true
					);
			}
		}, 2000);
	}
	function loginCard() {
		if (!activeLogin) return null;
		const card = el('section', undefined, 'fl-card');
		card.append(el('h3', 'Account sign-in'), el('p', activeLogin.message));
		if (activeLogin.url) {
			card.append(
				el(
					'p',
					signInOpened
						? activeLogin.hosted
							? 'Sign-in opened in a new tab. Once you finish there, your agent will complete the connection automatically.'
							: 'Sign-in opened in a new tab. Finish with your provider, then return here to complete the connection.'
						: 'Your browser may have blocked the sign-in tab. Open sign-in below to continue.'
				)
			);
			const a = el('a', signInOpened ? 'Reopen sign-in' : 'Open sign-in', 'fl-btn');
			a.href = activeLogin.url;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			card.append(a);
		}
		if (activeLogin.code) card.append(el('p', activeLogin.code, 'fl-device-code'));
		if (
			activeLogin.url &&
			!activeLogin.hosted &&
			selected === 'google' &&
			activeLogin.state === 'awaiting_consent'
		) {
			const form = el('form');
			const input = el('input');
			input.type = 'url';
			input.required = true;
			input.maxLength = 8192;
			input.autocomplete = 'off';
			const finish = el('button', 'Complete sign-in', 'fl-btn fl-btn-primary');
			finish.type = 'submit';
			finish.disabled = !canWrite();
			form.append(field('Full redirect URL after consent', input), finish);
			form.addEventListener('submit', (event) => {
				event.preventDefault();
				void act(finish, async () => {
					const value = input.value;
					input.value = '';
					activeLogin = (await client.invoke('finish', {
						id: activeLogin!.id,
						redirect: value
					})) as typeof activeLogin;
					if (!disposed) {
						render();
						await load();
					}
				});
			});
			card.append(form);
		}
		if (['starting', 'awaiting_consent'].includes(activeLogin.state)) {
			const cancel = button('Cancel sign-in', async () => {
				await act(cancel, async () => {
					activeLogin = (await client.invoke('cancel', {
						id: activeLogin!.id
					})) as typeof activeLogin;
					closePendingTab();
					render();
				});
			});
			cancel.disabled = !canWrite();
			card.append(cancel);
		} else if (!['verifying'].includes(activeLogin.state))
			card.append(
				button('Dismiss', () => {
					activeLogin = null;
					render();
				})
			);
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
			const integration = status?.integrations.find((i) => i.id === id);
			const b = button('', () => navigate(id));
			b.className = `fl-integration${selected === id ? ' fl-selected' : ''}`;
			b.setAttribute('aria-current', selected === id ? 'page' : 'false');
			const count = accounts.filter((a) => a.provider === id && a.state === 'connected').length;
			const mark = el('span', id === 'google' ? 'G' : 'M', 'fl-provider-mark');
			mark.setAttribute('aria-hidden', 'true');
			const label = el('span', undefined, 'fl-nav-copy');
			label.append(
				el('span', id === 'google' ? 'Google' : 'Microsoft', 'fl-integration-name'),
				el(
					'span',
					integration ? (count ? `${count} connected` : 'Not connected') : 'Checking…',
					'fl-muted'
				)
			);
			const dot = el('span', undefined, `fl-dot${count ? ' fl-dot-ok' : ''}`);
			dot.setAttribute('aria-hidden', 'true');
			b.append(mark, label, dot);
			nav.append(b);
		}
		// Keep the active form node mounted across status refreshes so input and focus survive.
		detail.replaceChildren();
		if (!selected || !status) {
			if (!status) detail.append(el('p', 'Checking integrations…'));
			return;
		}
		const integration = status.integrations.find((i) => i.id === selected)!;
		const back = button('← Integrations', () => navigate(null));
		back.classList.add('fl-back');
		const providerHeader = el('header', undefined, 'fl-provider-header');
		const identity = el('div', undefined, 'fl-provider-identity');
		const mark = el(
			'span',
			integration.id === 'google' ? 'G' : 'M',
			'fl-provider-mark fl-provider-mark-large'
		);
		mark.setAttribute('aria-hidden', 'true');
		const providerCopy = el('div');
		providerCopy.append(
			el('h2', integration.name),
			el('p', `${integration.cli} · ${toolLabel(integration.tool)}`, 'fl-muted')
		);
		identity.append(mark, providerCopy);
		const ready = integration.setup.state === 'ready' && integration.tool.state === 'installed';
		const badge = el(
			'span',
			ready
				? 'Ready to connect'
				: integration.setup.state !== 'ready'
					? 'Setup required'
					: 'Tool required',
			`fl-badge${ready ? ' fl-badge-ok' : ''}`
		);
		providerHeader.append(identity, badge);
		detail.append(back, providerHeader);
		const tool = el('details', undefined, 'fl-tool');
		tool.open = !ready;
		const summary = el('summary');
		summary.append(
			el('span', 'Connection setup'),
			el('span', ready ? 'Ready' : 'Needs attention', 'fl-muted')
		);
		tool.append(summary);
		const setupRow = el('div', undefined, 'fl-setup-row');
		const setupCopy = el('div');
		setupCopy.append(
			el(
				'h4',
				integration.setup.state === 'ready'
					? 'Application configured'
					: 'Application setup required'
			),
			el(
				'p',
				integration.setup.state === 'ready'
					? 'Your administrator has configured this connection.'
					: integration.setup.message,
				'fl-muted'
			)
		);
		setupRow.append(
			el('span', integration.setup.state === 'ready' ? '✓' : '1', 'fl-step'),
			setupCopy
		);
		tool.append(setupRow);
		const cliRow = el('div', undefined, 'fl-setup-row');
		const cliCopy = el('div');
		cliCopy.append(
			el(
				'h4',
				integration.tool.state === 'installed' ? 'CLI installed' : 'Install the connection tool'
			),
			el('p', `${integration.cli} · ${toolLabel(integration.tool)}`, 'fl-muted')
		);
		cliRow.append(
			el('span', integration.tool.state === 'installed' ? '✓' : '2', 'fl-step'),
			cliCopy
		);
		const installButton = button(
			integration.tool.state === 'not_installed'
				? 'Install CLI'
				: `Install / update to ${integration.qualified_version}`,
			async () => {
				await act(
					installButton,
					async () => {
						await client.invoke('install', { provider: selected! });
						await load();
					},
					'Qualified CLI installed and verified. Existing credentials retained.'
				);
			}
		);
		installButton.disabled = !canWrite();
		const updates = el('p', 'Updates: not checked', 'fl-muted');
		const checkUpdates = button('Check updates', async () => {
			await act(checkUpdates, async () => {
				const u = (await client.invoke('updates', { provider: selected! })) as any;
				updates.textContent =
					u.state === 'check_failed'
						? 'Update check failed — latest version unknown.'
						: `Latest release: ${u.latest_version}. Qualified version: ${u.qualified_version}.${u.qualification_pending ? ' Newer release requires qualification before installation.' : ''}`;
			});
		});
		const toolActions = el('div', undefined, 'fl-actions');
		toolActions.append(installButton, checkUpdates);
		cliCopy.append(updates);
		cliRow.append(toolActions);
		tool.append(cliRow);
		const list = accounts.filter((a) => a.provider === selected);
		const accountHeading = el('div', undefined, 'fl-section-heading');
		const accountTitle = el('div');
		accountTitle.append(
			el('h3', 'Accounts'),
			el('p', 'Connected accounts and their access.', 'fl-muted')
		);
		accountHeading.append(accountTitle);
		if (list.length && ready) {
			const add = button('Connect account', () => accountForm(), true);
			add.disabled = !canWrite();
			accountHeading.append(add);
		}
		detail.append(accountHeading);
		if (!list.length) {
			const empty = el('section', undefined, 'fl-empty');
			empty.append(
				el('span', integration.id === 'google' ? 'G' : 'M', 'fl-empty-mark'),
				el('h3', `No ${integration.name} accounts connected`),
				el(
					'p',
					ready
						? 'Choose an owner, label the account, then select the permissions you want to connect.'
						: 'Complete the connection setup below to add your first account.',
					'fl-muted'
				)
			);
			if (ready) {
				const add = button('Connect account', () => accountForm(), true);
				add.disabled = !canWrite();
				empty.append(add);
			}
			detail.append(empty);
		}
		for (const a of list) {
			const card = el('section', undefined, 'fl-card fl-account');
			const identity = el('div', undefined, 'fl-account-identity');
			const avatar = el(
				'span',
				(a.email ?? a.owner?.name ?? '?').slice(0, 1).toUpperCase(),
				'fl-account-avatar'
			);
			avatar.setAttribute('aria-hidden', 'true');
			const accountName = el('div', undefined, 'fl-account-name');
			accountName.append(el('h4', a.email ?? 'Finish connecting your account'));
			const meta = el('div', undefined, 'fl-account-meta');
			meta.append(el('span', a.owner ? `Owner: ${a.owner.name}` : 'Choose an account owner'));
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
			const healthy = a.state === 'connected';
			const state = el(
				'span',
				{
					connected: 'Connected',
					discovered: 'Not checked',
					check_failed: 'Needs attention',
					disconnected: 'Not connected',
					pending: 'Finish sign-in',
					failed: 'Sign-in incomplete'
				}[a.state],
				`fl-account-status${healthy ? ' fl-account-status-ok' : ''}`
			);
			identity.append(avatar, accountName, state);
			card.append(identity);
			const access = accessSummary(a);
			const body = el('div', undefined, 'fl-account-access');
			if (access) {
				body.append(el('h5', access.title));
				if (access.items.length) {
					const capabilities = el('ul', undefined, 'fl-access-list');
					for (const capability of access.items) capabilities.append(el('li', capability));
					body.append(capabilities);
				}
				if (access.note) body.append(el('p', access.note, 'fl-muted'));
			} else
				body.append(
					el(
						'p',
						a.state === 'disconnected'
							? 'This account is no longer connected.'
							: 'Complete sign-in to connect this account.',
						'fl-muted'
					)
				);
			card.append(body);
			if (a.connection_error)
				card.append(el('p', a.connection_error.message, 'fl-error fl-account-error'));
			else if (a.state === 'failed')
				card.append(
					el('p', 'Sign-in did not complete. Try connecting again.', 'fl-error fl-account-error')
				);
			const footer = el('div', undefined, 'fl-account-footer');
			const actions = el('div', undefined, 'fl-actions');
			const edit = button('Edit details', () => accountForm(a, true));
			edit.disabled = !canWrite();
			actions.append(edit);
			const reconnect = button(
				a.state === 'connected'
					? 'Change access'
					: a.state === 'failed' || a.state === 'pending'
						? 'Finish sign-in'
						: 'Reconnect',
				() => accountForm(a),
				a.state !== 'connected'
			);
			reconnect.disabled = !canWrite() || integration.setup.state !== 'ready';
			if (!a.external) footer.append(reconnect);
			else
				card.append(
					el(
						'p',
						'This account was connected outside Link. Sign-in changes aren’t available here yet.',
						'fl-muted'
					)
				);
			const check = button('Check connection', async () => {
				await act(
					check,
					async () => {
						await client.invoke('check', { account_id: a.id });
						await load();
					},
					'Sign-in is working.'
				);
			});
			check.disabled = !canWrite() || !a.email || a.state === 'disconnected';
			actions.append(check);
			if (a.state !== 'disconnected' && !a.external) {
				const disconnect = button('Disconnect', () => {
					closeForm();
					const confirm = el('section', undefined, 'fl-card');
					confirm.append(
						el('h3', `Disconnect ${a.email ?? 'this incomplete sign-in'}?`),
						el(
							'p',
							'This removes this account’s local credentials. Provider consent is not revoked, and other accounts are unchanged.'
						)
					);
					const yes = button('Disconnect account', async () => {
						await act(
							yes,
							async () => {
								await client.invoke('disconnect', { account_id: a.id });
								closeForm();
								await load();
							},
							'Local credentials removed. Provider consent was not revoked.'
						);
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
			detail.append(card);
		}
		if (activeLogin?.provider === selected) {
			const login = loginCard();
			if (login) detail.append(login);
		}
		detail.append(formHost, tool);
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
