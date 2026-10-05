import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import './control-ui.css';
import { PLUGIN_ID } from './identity.js';
import { mountWork, PAGE_ID } from './ui/app.js';

export default defineControlUiPlugin({
	id: PLUGIN_ID,
	activate(host) {
		host.ui.registerPage({
			id: PAGE_ID,
			label: 'Work',
			mount: (container, context) => mountWork(container, context)
		});
		host.ui.registerNavigation({
			id: PAGE_ID,
			label: 'Work',
			page: { id: PAGE_ID },
			icon: 'listChecks'
		});
	}
});
