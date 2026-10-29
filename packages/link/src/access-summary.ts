import { BASE_SCOPES, describeSelection, type Account, type Catalog } from './model.js';

// Translate known capabilities, not scope names or selected permission IDs, into user-facing text.
const accessLabels: Record<string, string> = {
	'gmail.readonly': 'Read email',
	'gmail.send': 'Send email',
	'gmail.compose': 'Create email drafts and send email',
	'gmail.modify': 'Read, send, organize and delete (to trash) email',
	'https://mail.google.com/': 'Manage all email, including permanent deletion',
	'gmail.settings.basic': 'Manage email settings',
	'gmail.settings.sharing': 'Manage email forwarding, delegation and send-as settings',
	'calendar.readonly': 'View calendars and events',
	calendar: 'Manage calendars and events',
	'contacts.readonly': 'View contacts',
	'contacts.other.readonly': 'View other contacts',
	'directory.readonly': 'View the contact directory',
	contacts: 'Manage contacts',
	'drive.readonly': 'View files',
	drive: 'Manage files',
	'drive.file': 'Manage files opened with this app',
	spreadsheets: 'Manage spreadsheets',
	documents: 'Manage documents',
	'documents.readonly': 'View documents',
	'spreadsheets.readonly': 'View spreadsheets',
	presentations: 'Manage presentations',
	'presentations.readonly': 'View presentations',
	tasks: 'Manage tasks',
	'tasks.readonly': 'View tasks',
	'forms.body': 'Manage forms',
	'forms.body.readonly': 'View forms',
	'forms.responses.readonly': 'View form responses',
	'meetings.space.created': 'Manage meetings created by this app',
	'meetings.space.readonly': 'View meetings',
	'meetings.space.settings': 'Manage meeting settings',
	'script.projects': 'Manage Apps Script projects',
	'script.projects.readonly': 'View Apps Script projects',
	'script.deployments': 'Manage Apps Script deployments',
	'script.deployments.readonly': 'View Apps Script deployments',
	'script.processes': 'View Apps Script runs',
	'analytics.readonly': 'View Analytics data',
	webmasters: 'Manage Search Console',
	'webmasters.readonly': 'View Search Console data',
	'drive.activity.readonly': 'View Drive activity',
	'drive.labels.readonly': 'View Drive labels',
	'youtube.readonly': 'View YouTube account',
	'photoslibrary.readonly.appcreateddata': 'View photos added by this app',
	'photoslibrary.appendonly': 'Upload photos and create albums',
	'chat.spaces': 'Manage Chat spaces',
	'chat.spaces.readonly': 'View Chat spaces',
	'chat.messages': 'Read and send Chat messages',
	'chat.messages.readonly': 'Read Chat messages',
	'chat.memberships': 'Manage Chat memberships',
	'chat.memberships.readonly': 'View Chat memberships',
	'chat.users.readstate.readonly': 'View Chat read state',
	'chat.messages.reactions.create': 'Add Chat reactions',
	'chat.messages.reactions.readonly': 'View Chat reactions',
	'Mail.Read': 'Read email',
	'Mail.Send': 'Send email',
	'Mail.ReadWrite': 'Read, organize, write drafts and delete email, including permanently',
	'Calendars.Read': 'View calendars and events',
	'Calendars.ReadWrite': 'Manage calendars and events',
	'Contacts.Read': 'View contacts',
	'Contacts.ReadWrite': 'Manage contacts',
	'Tasks.Read': 'View tasks',
	'Tasks.ReadWrite': 'Manage tasks',
	'Files.Read': 'View files',
	'Files.ReadWrite': 'Manage files',
	'Group.Read.All': 'View groups',
	'GroupMember.Read.All': 'View group membership',
	'Files.ReadWrite.All': 'Manage all files'
};
function scopeItems(a: Account, values: string[]) {
	const baseline = new Set([
		...BASE_SCOPES[a.provider],
		'profile',
		'https://www.googleapis.com/auth/userinfo.profile'
	]);
	const items = new Set<string>();
	let additional = false;
	for (const scope of values) {
		if (baseline.has(scope)) continue;
		const key =
			a.provider === 'google'
				? scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')
				: scope;
		const label = accessLabels[key];
		if (label) items.add(label);
		else additional = true;
	}
	for (const [broad, narrow] of [
		['Read, send, organize and delete (to trash) email', 'Read email'],
		['Read, send, organize and delete (to trash) email', 'Send email'],
		['Read, send, organize and delete (to trash) email', 'Create email drafts and send email'],
		['Create email drafts and send email', 'Send email'],
		['Manage calendars and events', 'View calendars and events'],
		['Manage contacts', 'View contacts'],
		['Manage tasks', 'View tasks'],
		['Manage files', 'View files']
	])
		if (items.has(broad)) items.delete(narrow);
	if (additional) items.add('Additional permissions');
	return [...items];
}
// Granted access when the provider confirmed it; otherwise what was recorded or selected.
export function accessSummary(a: Account, catalog?: Catalog | null) {
	if (!['connected', 'discovered', 'check_failed'].includes(a.state)) return null;
	const name = a.provider === 'google' ? 'Google' : 'Microsoft';
	if (Array.isArray(a.granted_scopes)) {
		const missing = catalog
			? describeSelection(a.provider, catalog, a.grant?.selected_not_granted ?? [])
			: [];
		return {
			title: 'Allowed access',
			items: scopeItems(a, a.granted_scopes),
			note: [
				a.granted_scopes.length ? '' : 'No account service access.',
				missing.length ? `${name} didn't grant: ${missing.join(', ')}.` : ''
			]
				.filter(Boolean)
				.join(' ')
		};
	}
	if (a.recorded_scopes?.length)
		return {
			title: 'Recorded at sign-in',
			items: scopeItems(a, a.recorded_scopes),
			note: `Not confirmed by ${name}.`
		};
	const selected = catalog ? describeSelection(a.provider, catalog, a.requested) : [];
	if (selected.length)
		return {
			title: `Selected — not confirmed by ${name}`,
			items: selected,
			note:
				a.grant?.status === 'unknown'
					? "Microsoft didn't confirm which permissions it granted."
					: ''
		};
	return {
		title: 'Account access',
		items: [],
		note: 'Access details aren’t available for this account.'
	};
}
