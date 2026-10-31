import type { ProviderUi } from '../types.js';

// Preview.8 Google selections. Each maps to the gog Gmail mode or read level it requested.
const GOOGLE_PREVIOUS = [
	'gmail-read',
	'gmail-send',
	'gmail-drafts',
	'calendar',
	'contacts',
	'drive'
];
export function normalizeGoogle(selected: string[]) {
	const previous = new Set(selected.filter((id) => GOOGLE_PREVIOUS.includes(id)));
	if (!previous.size) return selected;
	const out = selected.filter((id) => !previous.has(id));
	const [read, send, drafts] = ['gmail-read', 'gmail-send', 'gmail-drafts'].map((id) =>
		previous.has(id)
	);
	if (drafts) out.push(send ? 'gmail:compose' : 'gmail:read-compose');
	else if (read && send) out.push('gmail:read-send');
	else if (read) out.push('gmail:readonly');
	else if (send) out.push('gmail:send');
	for (const service of ['calendar', 'contacts', 'drive'])
		if (previous.has(service)) out.push(`${service}:read`);
	return out;
}

const ui: ProviderUi = {
	id: 'google',
	name: 'Google',
	cli: 'gog',
	baseline: ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'],
	normalize: normalizeGoogle,
	offer: (selected) =>
		normalizeGoogle(selected).map((id) => (id === 'gmail:read-compose' ? 'gmail:compose' : id)),
	permissions: 'catalog',
	email_required: true,
	connect: 'Sign in with Google',
	revoke: () => ({
		lead: '',
		links: [{ label: "Google's app-access page", href: 'https://myaccount.google.com/connections' }]
	}),
	access: {
		key: (scope) => scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''),
		// Known capabilities, not scope names, in user-facing text.
		labels: {
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
			'chat.messages.reactions.readonly': 'View Chat reactions'
		}
	}
};
export default ui;
