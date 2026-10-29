import type { ProviderUi } from '../types.js';
import { DROPBOX_CATALOG, TEAM } from './catalog.js';

// Single scopes Dropbox can grant outside a row's level, for example a scope it adds as a
// dependency of another.
const SINGLE: Record<string, string> = {
	'files.metadata.read': 'See file and folder names',
	'files.metadata.write': 'Change file and folder names and details',
	'files.content.read': 'Open and download files',
	'files.content.write': 'Upload, edit and delete files',
	'sharing.read': 'See shared links and folders',
	'file_requests.read': 'See file requests',
	'contacts.read': 'See contacts'
};
// Plain words for granted scopes, by row: the highest level fully granted, plus the addon.
export function describeDropbox(scopes: string[]) {
	const granted = new Set(scopes);
	const used = new Set<string>();
	const items: string[] = [];
	for (const row of DROPBOX_CATALOG.rows) {
		const level = [...row.levels].reverse().find((l) => l.scopes.every((s) => granted.has(s)));
		for (const choice of [level, row.addon])
			if (choice && choice.scopes.every((s) => granted.has(s))) {
				items.push(choice.label);
				for (const s of choice.scopes) used.add(s);
			}
	}
	let other = false;
	for (const s of scopes)
		if (!used.has(s)) {
			if (SINGLE[s]) items.push(SINGLE[s]);
			else if (s !== TEAM + 'account_info.read') other = true;
		}
	if (other) items.push('Other Dropbox permissions');
	return [...new Set(items)];
}

const ui: ProviderUi = {
	id: 'dropbox',
	name: 'Dropbox',
	cli: 'dbxcli',
	// Link reads the account (users/get_current_account) to confirm who signed in.
	baseline: ['account_info.read'],
	permissions: 'catalog',
	connect: 'Sign in with Dropbox',
	revoke: () => ({
		lead: '',
		links: [
			{
				label: "Dropbox's connected apps page",
				href: 'https://www.dropbox.com/account/connected_apps'
			}
		]
	}),
	// Found in dbxcli's own store; the address is known after the first check.
	title: (a) => (a.email ? null : 'Dropbox account (not checked yet)'),
	access: { labels: {}, describe: describeDropbox }
};
export default ui;
