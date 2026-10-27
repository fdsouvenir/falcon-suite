import { BASE_SCOPES, requestedScopes, type Account } from './model.js';

// Translate known capabilities, not scope names or selected permission IDs, into user-facing text.
const accessLabels: Record<string, string> = {
	'gmail.readonly': 'Read email',
	'gmail.send': 'Send email',
	'gmail.compose': 'Create email drafts and send email',
	'gmail.modify': 'Read, organize and send email',
	'https://mail.google.com/': 'Manage all email, including permanent deletion',
	'gmail.settings.basic': 'Manage email settings',
	'gmail.settings.sharing': 'Manage email sharing settings',
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
	'Mail.Read': 'Read email',
	'Mail.Send': 'Send email',
	'Mail.ReadWrite': 'Read, create, modify and delete email (including drafts)',
	'Calendars.Read': 'View calendars and events',
	'Calendars.ReadWrite': 'Manage calendars and events',
	'Contacts.Read': 'View contacts',
	'Contacts.ReadWrite': 'Manage contacts',
	'Tasks.Read': 'View tasks',
	'Tasks.ReadWrite': 'Manage tasks',
	'Files.Read': 'View files',
	'Files.ReadWrite': 'Manage files',
	'Group.Read.All': 'View groups',
	'GroupMember.Read.All': 'View group membership'
};
export function accessSummary(a: Account) {
	if (!['connected', 'discovered', 'check_failed'].includes(a.state)) return null;
	if (Array.isArray(a.granted_scopes) && a.granted_scopes.length === 0)
		return { title: 'Allowed access', items: [], note: 'No account service access.' };
	let values = a.granted_scopes ?? a.recorded_scopes;
	if (a.granted_scopes === null && !values?.length && a.requested.length) {
		try {
			values = requestedScopes(a.provider, a.requested);
		} catch {
			values = null;
		}
	}
	if (!values?.length)
		return {
			title: 'Account access',
			items: [],
			note: 'Access details aren’t available for this account.'
		};
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
		['Read, organize and send email', 'Read email'],
		['Read, organize and send email', 'Send email'],
		['Create email drafts and send email', 'Send email'],
		['Manage calendars and events', 'View calendars and events'],
		['Manage contacts', 'View contacts'],
		['Manage tasks', 'View tasks'],
		['Manage files', 'View files']
	])
		if (items.has(broad)) items.delete(narrow);
	if (additional) items.add('Additional permissions');
	return {
		title: a.granted_scopes !== null ? 'Allowed access' : 'Selected access',
		items: [...items],
		note:
			a.granted_scopes !== null ? '' : 'Saved from sign-in. Current permissions aren’t confirmed.'
	};
}
