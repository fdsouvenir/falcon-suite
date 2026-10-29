export type Provider = 'google' | 'microsoft';
export type Owner = { kind: 'human' | 'agent'; id: string; name: string };
export type Purpose = { kind: 'work' | 'personal' | 'other'; label?: string };
export type Account = {
	id: string;
	provider: Provider;
	owner: Owner | null;
	purpose: Purpose | null;
	email: string | null;
	provider_id: string | null;
	requested: string[];
	recorded_scopes?: string[] | null;
	granted_scopes: string[] | null;
	external?: { selection: string; client?: string };
	state: 'discovered' | 'pending' | 'connected' | 'check_failed' | 'disconnected' | 'failed';
	checked_at: string | null;
	created_at: string;
	connection_error?: { code: string; message: string };
};
export type Permission = { id: string; label: string; scopes: string[] };
const graph = (id: string, label: string, ...scopes: string[]): Permission => ({
	id,
	label,
	scopes
});
export const PERMISSIONS: Record<Provider, Permission[]> = {
	google: [
		graph('gmail-read', 'Mail — read', 'https://www.googleapis.com/auth/gmail.readonly'),
		graph('gmail-send', 'Mail — send', 'https://www.googleapis.com/auth/gmail.send'),
		graph(
			'gmail-drafts',
			'Mail — read, drafts and send (Google bundles these)',
			'https://www.googleapis.com/auth/gmail.compose',
			'https://www.googleapis.com/auth/gmail.readonly'
		),
		graph('calendar', 'Calendar — read', 'https://www.googleapis.com/auth/calendar.readonly'),
		graph(
			'contacts',
			'Contacts and directory — read',
			'https://www.googleapis.com/auth/contacts.readonly',
			'https://www.googleapis.com/auth/contacts.other.readonly',
			'https://www.googleapis.com/auth/directory.readonly'
		),
		graph('drive', 'Files — read', 'https://www.googleapis.com/auth/drive.readonly')
	],
	microsoft: [
		graph('mail-read', 'Mail — read', 'Mail.Read'),
		graph(
			'mail-write',
			'Mail — read, create, modify and delete email (including drafts)',
			'Mail.ReadWrite'
		),
		graph('mail-send', 'Mail — send', 'Mail.Send'),
		graph('calendar', 'Calendar — read and write', 'Calendars.Read', 'Calendars.ReadWrite'),
		graph('contacts', 'Contacts — read and write', 'Contacts.Read', 'Contacts.ReadWrite'),
		graph('tasks', 'Tasks — read and write', 'Tasks.Read', 'Tasks.ReadWrite'),
		graph('onedrive', 'Files — read and write', 'Files.Read', 'Files.ReadWrite'),
		graph('excel', 'Excel — read and write (business only)', 'Files.ReadWrite'),
		graph(
			'groups',
			'Groups — read (business; admin consent required)',
			'Group.Read.All',
			'GroupMember.Read.All'
		)
	]
};
export const BASE_SCOPES: Record<Provider, string[]> = {
	google: ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'],
	microsoft: ['openid', 'profile', 'offline_access', 'User.Read']
};
export function requestedScopes(provider: Provider, selected: string[]): string[] {
	if (
		!selected.length ||
		new Set(selected).size !== selected.length ||
		selected.some((id) => !PERMISSIONS[provider].some((p) => p.id === id))
	)
		throw new Error('Select supported permissions.');
	return [
		...new Set([
			...BASE_SCOPES[provider],
			...selected.flatMap((id) => PERMISSIONS[provider].find((p) => p.id === id)!.scopes)
		])
	];
}
export function validateMetadata(owner: Owner, purpose: Purpose) {
	if (
		!['human', 'agent'].includes(owner.kind) ||
		!/^[a-zA-Z0-9_.:-]{1,128}$/.test(owner.id) ||
		!owner.name.trim() ||
		owner.name.length > 80 ||
		/[\r\n\x00-\x1f]/.test(owner.name)
	)
		throw new Error('Choose an existing human or agent.');
	if (
		!['work', 'personal', 'other'].includes(purpose.kind) ||
		(purpose.kind === 'other' &&
			(!purpose.label?.trim() ||
				purpose.label.length > 40 ||
				/[\r\n\x00-\x1f]/.test(purpose.label))) ||
		(purpose.kind !== 'other' && purpose.label !== undefined)
	)
		throw new Error('Choose Work, Personal, or Other with a label of up to 40 characters.');
}
