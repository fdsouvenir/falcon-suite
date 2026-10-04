import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import './control-ui.css';
import { PLUGIN_ID } from './identity.js';

export const PAGE_ID = 'work';

export default defineControlUiPlugin({
	id: PLUGIN_ID,
	activate(host) {
		host.ui.registerPage({
			id: PAGE_ID,
			label: 'Work',
			mount(container) {
				const page = document.createElement('section');
				page.className = 'falcon-work-page';
				const title = document.createElement('h1');
				title.className = 'falcon-work-title';
				title.textContent = 'Work';
				const empty = document.createElement('p');
				empty.className = 'falcon-work-empty';
				empty.textContent = 'No Work recorded yet.';
				page.append(title, empty);
				container.append(page);
				return { dispose: () => page.remove() };
			}
		});
		host.ui.registerNavigation({
			id: PAGE_ID,
			label: 'Work',
			page: { id: PAGE_ID },
			icon: 'listChecks'
		});
	}
});
