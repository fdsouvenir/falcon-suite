import type { ProviderUi } from '../types.js';

// Choices to preselect when someone changes an account saved with a compatibility bundle.
const EQUIVALENTS: Record<string, string[]> = {
	mail: ['mail-read', 'mail-send'],
	calendar: ['calendar-write'],
	contacts: ['contacts-write'],
	tasks: ['tasks-write'],
	onedrive: ['onedrive-write']
};
const consumer = {
	label: "Microsoft's app-access page",
	href: 'https://account.live.com/consent/Manage'
};
const enterprise = {
	label: "Microsoft's app-access page",
	href: 'https://myapplications.microsoft.com/'
};

const ui: ProviderUi = {
	id: 'microsoft',
	name: 'Microsoft',
	cli: 'm365cli',
	baseline: ['openid', 'profile', 'offline_access', 'User.Read'],
	offer: (selected) => selected.flatMap((id) => EQUIVALENTS[id] ?? [id]),
	permissions: 'catalog',
	connect: 'Sign in with Microsoft',
	revoke: (a) =>
		a.audience === 'consumer'
			? { lead: '', links: [consumer] }
			: a.audience === 'enterprise'
				? { lead: '', links: [enterprise] }
				: {
						lead: "Microsoft's app-access page for ",
						links: [
							{ label: 'personal accounts', href: consumer.href },
							{ label: 'work or school accounts', href: enterprise.href }
						]
					},
	access: {
		labels: {
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
		}
	}
};
export default ui;
