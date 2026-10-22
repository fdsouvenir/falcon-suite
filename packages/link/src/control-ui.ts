import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import type { ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from './contract.js';
import { PLUGIN_ID, PLUGIN_VERSION } from './identity.js';
import type { Overview, ToolStatus } from './status.js';
import './control-ui.css';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
	const node = document.createElement(tag);
	if (text) node.textContent = text;
	return node;
}
const toolLabel = (tool: ToolStatus): string => {
	switch (tool.state) {
		case 'installed':
			return `Installed · ${tool.version}`;
		case 'not_installed':
			return 'Not installed';
		case 'check_failed':
			return 'Version check failed — installation status is unknown';
		case 'unrecognized_version':
			return 'Tool responded, but its version was not recognized';
		case 'unqualified':
			return 'Installation check not yet available';
	}
};

function mount(container: HTMLElement, context: ControlUiViewContext) {
	const client = createFeatureClient(contract, context.host);
	const root = element('section');
	root.className = 'fl-page';
	const headingVersion = PLUGIN_VERSION.includes('-')
		? PLUGIN_VERSION.split('-').slice(1).join('-')
		: PLUGIN_VERSION;
	root.append(element('h1', `Falcon Link v${headingVersion}`));
	root.append(element('p', 'Connect and maintain your Google and Microsoft accounts.'));
	const refresh = element('button', 'Refresh status');
	refresh.type = 'button';
	const content = element('div');
	content.setAttribute('aria-live', 'polite');
	root.append(refresh, content);
	container.append(root);
	let disposed = false;
	let generation = 0;
	async function render() {
		const current = ++generation;
		refresh.disabled = true;
		content.replaceChildren(element('p', 'Checking integration status…'));
		try {
			const result = (await client.invoke('status', {})) as Overview;
			if (disposed || current !== generation) return;
			content.replaceChildren();
			for (const integration of result.integrations) {
				const card = element('section');
				card.className = 'fl-integration';
				card.append(element('h2', `${integration.name} · ${integration.cli}`));
				card.append(element('p', toolLabel(integration.tool)));
				card.append(element('p', 'Updates: not checked'));
				card.append(element('p', integration.setup.message));
				card.append(
					element(
						'p',
						'Accounts: not checked. This build does not inspect or change existing accounts.'
					)
				);
				content.append(card);
			}
			content.append(
				element('p', `Status checked: ${new Date(result.checked_at).toLocaleString()}`)
			);
		} catch {
			if (!disposed && current === generation)
				content.replaceChildren(
					element('p', 'Integration status could not be loaded. Try refreshing.')
				);
		} finally {
			if (!disposed && current === generation) refresh.disabled = false;
		}
	}
	refresh.addEventListener('click', render);
	void render();
	return {
		update() {
			void render();
		},
		dispose() {
			disposed = true;
			generation++;
			refresh.removeEventListener('click', render);
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
