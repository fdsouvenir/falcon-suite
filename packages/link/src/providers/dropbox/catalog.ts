import type { Catalog, Level, Row } from '../../model.js';

// Dropbox permission rows. Dropbox has no CLI catalog: dbxcli's own login asks for every scope
// the app allows, so Link chooses the scopes and signs in itself.
//
// Scopes in the team section start with `team:`. Dropbox links any sign-in that asks for a team
// scope to the whole team instead of the person, so team scopes are requested in a second
// sign-in that a team admin approves. Link strips the prefix when it asks Dropbox.
export const TEAM = 'team:';
const level = (id: string, label: string, description: string, scopes: string[]): Level => ({
	id,
	label,
	description,
	scopes
});
// Link confirms which team approved with team/get_info, which needs team_info.read.
const team = (scopes: string[]) => [TEAM + 'team_info.read', ...scopes.map((s) => TEAM + s)];
// Acting as a team member (dbxcli --as-member) needs team_data.member; dbxcli also reads the
// member's account (account_info.read) to find their root folder.
const memberFiles = ['team_data.member', 'account_info.read', 'team_data.team_space'];
const files = ['files.metadata.read', 'files.content.read'];
const changeFiles = [...files, 'files.metadata.write', 'files.content.write'];

const rows: Row[] = [
	{
		id: 'files',
		label: 'Files',
		description: 'Your files and folders in Dropbox.',
		group: 'main',
		levels: [
			level(
				'files:view',
				'View files',
				'See your files and folders, and open or download them.',
				files
			),
			level(
				'files:change',
				'View and change files',
				"Also upload, edit, move, rename and delete files. Deleted files stay in Dropbox's deleted files, where they can be restored.",
				changeFiles
			)
		],
		addon: level('files:permanent-delete', "Permanently delete files (can't be recovered)", '', [
			'files.permanent_delete'
		]),
		addon_requires: 'files:change'
	},
	{
		id: 'sharing',
		label: 'Sharing',
		description: 'Shared links and shared folders.',
		group: 'main',
		levels: [
			level(
				'sharing:view',
				'See shared links and folders',
				'See your shared links and who your files and folders are shared with.',
				['sharing.read']
			),
			level(
				'sharing:change',
				'Share files and manage links',
				'Also create and change shared links, and share files and folders with people.',
				['sharing.read', 'sharing.write']
			)
		]
	},
	{
		id: 'file_requests',
		label: 'File requests',
		description: 'Requests that let other people upload files to your Dropbox.',
		group: 'main',
		levels: [
			level('file_requests:view', 'See file requests', "See the file requests you've made.", [
				'file_requests.read'
			]),
			level(
				'file_requests:change',
				'Create and manage file requests',
				'Also create, change and close requests that let other people upload files to you.',
				['file_requests.read', 'file_requests.write']
			)
		]
	},
	{
		id: 'contacts',
		label: 'Contacts',
		description: "Contacts you've added to Dropbox.",
		group: 'main',
		levels: [
			level('contacts:view', 'See contacts', "See the contacts you've added to Dropbox.", [
				'contacts.read'
			]),
			level('contacts:change', 'Manage contacts', 'Also add and remove contacts.', [
				'contacts.read',
				'contacts.write'
			])
		]
	},
	{
		id: 'account',
		label: 'Account',
		description: 'Your name, photo and account settings.',
		group: 'main',
		levels: [],
		addon: level('account:change', 'Change account profile and settings', '', [
			'account_info.write'
		])
	},
	{
		id: 'team_info',
		label: 'Team info',
		description: "Your team's name, licenses and settings.",
		group: 'team',
		levels: [
			level(
				'team_info:view',
				'See team details',
				"See your team's name, licenses and settings.",
				team([])
			),
			level(
				'team_info:change',
				'See and change team details',
				"Also change your team's details.",
				team(['team_info.write'])
			)
		]
	},
	{
		id: 'members',
		label: 'Members',
		description: 'The people on your team.',
		group: 'team',
		levels: [
			level(
				'members:view',
				'See team members',
				"See who's on your team and their roles.",
				team(['members.read'])
			),
			level(
				'members:change',
				'Manage team members',
				'Also invite people, change roles and suspend members.',
				team(['members.read', 'members.write'])
			)
		],
		addon: level('members:remove', 'Remove members from the team', '', team(['members.delete'])),
		addon_requires: 'members:change'
	},
	{
		id: 'groups',
		label: 'Groups',
		description: 'Groups of people on your team.',
		group: 'team',
		levels: [
			level(
				'groups:view',
				'See team groups',
				"See your team's groups and who's in them.",
				team(['groups.read'])
			),
			level(
				'groups:change',
				'Manage team groups',
				'Also create and delete groups and change who is in them.',
				team(['groups.read', 'groups.write'])
			)
		]
	},
	{
		id: 'team_files',
		label: 'Team files and folders',
		description: "Team folders and members' files.",
		group: 'team',
		levels: [
			level(
				'team_files:view',
				'View team files',
				"Open and download files in team folders and in members' Dropbox, acting as a team member.",
				team([...memberFiles, 'team_data.content.read', 'files.team_metadata.read', ...files])
			),
			level(
				'team_files:change',
				'View and change team files',
				'Also upload, edit, move and delete them.',
				team([
					...memberFiles,
					'team_data.content.read',
					'team_data.content.write',
					'files.team_metadata.read',
					'files.team_metadata.write',
					...changeFiles
				])
			)
		]
	},
	{
		id: 'governance',
		label: 'Sharing and governance policies',
		description: 'Legal holds, data retention and other data governance.',
		group: 'team',
		levels: [
			level(
				'governance:view',
				'See team governance policies',
				'See legal holds, data retention and other data governance policies.',
				team(['team_data.governance.read'])
			),
			level(
				'governance:change',
				'Manage team governance policies',
				'Also create and change them.',
				team(['team_data.governance.read', 'team_data.governance.write'])
			)
		]
	},
	{
		id: 'sessions',
		label: 'Sign-in sessions',
		description: "Devices and browsers your team's members are signed in on.",
		group: 'team',
		levels: [
			level(
				'sessions:view',
				'See team sign-in sessions',
				"See which devices and browsers your team's members are signed in on.",
				team(['sessions.list'])
			),
			level(
				'sessions:change',
				'See and end team sign-in sessions',
				'Also sign members out of devices and browsers.',
				team(['sessions.list', 'sessions.modify'])
			)
		]
	},
	{
		id: 'events',
		label: 'Activity log',
		description: 'The record of what happens on your team.',
		group: 'team',
		levels: [
			level(
				'events:view',
				'See team activity log',
				"See your team's activity log.",
				team(['events.read'])
			),
			level(
				'events:change',
				'Manage team activity log',
				"Read and write your team's activity log.",
				team(['events.read', 'events.write'])
			)
		]
	}
];

export const DROPBOX_CATALOG: Catalog = {
	rows,
	saved: {},
	groups: {
		team: {
			title: 'Dropbox team administration — for team admins',
			note: 'These let the assistant manage your Dropbox team. A team admin must approve them.',
			chosen_note:
				'Dropbox asks twice: first you sign in with this account, then a team admin approves team administration.'
		}
	},
	technical: [
		'account_info.read is always included so Link can confirm which Dropbox account signed in.',
		'Scopes starting with team: are requested in a second sign-in that a team admin approves. It always includes team_info.read so Link can confirm the team. Team files access includes team_data.member, which Dropbox requires for acting as a team member.'
	]
};
// The two Dropbox sign-ins for a selection: the person's own, and the team admin's (if any).
export function splitScopes(scopes: string[]) {
	return {
		personal: scopes.filter((s) => !s.startsWith(TEAM)),
		team: scopes.filter((s) => s.startsWith(TEAM)).map((s) => s.slice(TEAM.length))
	};
}
