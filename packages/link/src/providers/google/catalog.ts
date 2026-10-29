import { selectionScopes, type Catalog, type Level, type Row } from '../../model.js';
import ui, { normalizeGoogle } from './ui.js';

const g = (...names: string[]) => names.map((n) => 'https://www.googleapis.com/auth/' + n);
const strings = (v: unknown) =>
	Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length <= 512)
		? (v as string[])
		: null;

// Google: rows come from `gog auth services --json`. Link keeps labels and the read-only
// scope sets gog requests for each service (gogcli 0.47.1,
// internal/googleauth/service.go scopesForServiceWithOptions with Readonly).
const GOOGLE_LABELS: Record<string, string> = {
	gmail: 'Email',
	calendar: 'Calendar',
	contacts: 'Contacts',
	drive: 'Drive',
	docs: 'Docs',
	sheets: 'Sheets',
	slides: 'Slides',
	tasks: 'Tasks',
	forms: 'Forms',
	chat: 'Chat',
	meet: 'Meet',
	classroom: 'Classroom',
	sites: 'Sites',
	youtube: 'YouTube',
	photos: 'Photos',
	appscript: 'Apps Script',
	analytics: 'Analytics',
	searchconsole: 'Search Console',
	driveactivity: 'Drive activity',
	drivelabels: 'Drive labels'
};
const GOOGLE_MAIN = ['gmail', 'calendar', 'contacts', 'drive'];
const GOOGLE_READ: Record<string, string[]> = {
	calendar: g('calendar.readonly'),
	chat: g(
		'chat.spaces.readonly',
		'chat.messages.readonly',
		'chat.memberships.readonly',
		'chat.users.readstate.readonly'
	),
	classroom: g(
		'classroom.courses.readonly',
		'classroom.rosters.readonly',
		'classroom.coursework.students.readonly',
		'classroom.coursework.me.readonly',
		'classroom.courseworkmaterials.readonly',
		'classroom.announcements.readonly',
		'classroom.topics.readonly',
		'classroom.guardianlinks.students.readonly',
		'classroom.profile.emails',
		'classroom.profile.photos'
	),
	drive: g('drive.readonly'),
	docs: g('drive.readonly', 'documents.readonly'),
	slides: g('drive.readonly', 'presentations.readonly'),
	contacts: g('contacts.readonly', 'contacts.other.readonly', 'directory.readonly'),
	tasks: g('tasks.readonly'),
	sheets: g('drive.readonly', 'spreadsheets.readonly'),
	forms: g('forms.body.readonly', 'forms.responses.readonly'),
	sites: g('drive.readonly'),
	meet: g('meetings.space.readonly'),
	appscript: g('script.projects.readonly', 'script.deployments.readonly'),
	searchconsole: g('webmasters.readonly'),
	photos: g('photoslibrary.readonly.appcreateddata')
};
// `--photos-scope append` adds upload and album creation to gog's read-only Photos scope.
const GOOGLE_CHANGE: Record<string, string[]> = {
	photos: g('photoslibrary.readonly.appcreateddata', 'photoslibrary.appendonly')
};
const GMAIL: Record<string, { mode: string; compose?: true; scopes: string[] }> = {
	readonly: { mode: 'readonly', scopes: g('gmail.readonly') },
	send: { mode: 'send', scopes: g('gmail.send') },
	'read-send': { mode: 'read-send', scopes: g('gmail.readonly', 'gmail.send') },
	'read-compose': { mode: 'readonly', compose: true, scopes: g('gmail.readonly', 'gmail.compose') },
	compose: {
		mode: 'read-send',
		compose: true,
		scopes: g('gmail.readonly', 'gmail.send', 'gmail.compose')
	},
	full: { mode: 'full', scopes: [] } // gog's own Gmail scopes, from auth services
};
const GOOGLE_DESCRIPTIONS: Record<string, string> = {
	'gmail:readonly': 'Read email.',
	'gmail:send': 'Send email.',
	'gmail:read-send': 'Read and send email.',
	'gmail:compose': 'Read email, write drafts and send email.',
	'gmail:full':
		'Read, send, organize and delete (to trash) email, and change mail settings, including forwarding and delegation.',
	'calendar:read': 'View calendars and events.',
	'calendar:write': 'View and change calendars and events.',
	'contacts:read': 'View contacts, other contacts and the directory.',
	'contacts:write': 'View and change contacts; view other contacts and the directory.',
	'drive:read': 'View files in Google Drive.',
	'drive:write': 'View, change and delete files in Google Drive.'
};
const driveNote = (service: string, scopes: string[]) =>
	service === 'drive'
		? ''
		: scopes.includes(g('drive')[0])
			? 'Includes changing files in Google Drive.'
			: scopes.includes(g('drive.readonly')[0])
				? 'Includes viewing files in Google Drive.'
				: '';
export function googleCatalog(services: unknown): Catalog {
	if (!Array.isArray(services)) throw new Error('Google services are unavailable.');
	const rows: Row[] = [];
	for (const entry of services as { service?: unknown; user?: unknown; scopes?: unknown }[]) {
		const service = entry?.service;
		const scopes = strings(entry?.scopes);
		if (
			typeof service !== 'string' ||
			!/^[a-z0-9]{1,32}$/.test(service) ||
			entry.user !== true ||
			!scopes?.length ||
			service === 'people'
		)
			continue;
		const level = (id: string, label: string, values: string[]): Level => ({
			id: `${service}:${id}`,
			label,
			description: GOOGLE_DESCRIPTIONS[`${service}:${id}`] ?? driveNote(service, values),
			scopes: values
		});
		const row: Row = {
			id: service,
			label: GOOGLE_LABELS[service] ?? service,
			group: GOOGLE_MAIN.includes(service) ? 'main' : 'more',
			levels:
				service === 'gmail'
					? [
							level('readonly', 'Read', GMAIL.readonly.scopes),
							level('send', 'Send only', GMAIL.send.scopes),
							level('read-send', 'Read and send', GMAIL['read-send'].scopes),
							level('compose', 'Read, write drafts and send', GMAIL.compose.scopes),
							level('full', 'Full access', scopes)
						]
					: GOOGLE_READ[service]
						? [
								level('read', 'Read', GOOGLE_READ[service]),
								level('write', 'Read and change', GOOGLE_CHANGE[service] ?? scopes)
							]
						: [level('on', 'On', scopes)]
		};
		if (service === 'gmail')
			row.note =
				'Google bundles drafts with sending, and organizing and settings with full access.';
		rows.push(row);
	}
	rows.sort(
		(a, b) => (GOOGLE_MAIN.indexOf(a.id) + 1 || 99) - (GOOGLE_MAIN.indexOf(b.id) + 1 || 99)
	);
	return {
		rows,
		saved: {
			'gmail:read-compose': {
				label: 'Email: Read and write drafts',
				scopes: GMAIL['read-compose'].scopes
			}
		}
	};
}
// One gog command requests every row's level: read-and-change services through --services and
// gog's scope flags, read-only scopes through --extra-scopes.
export function googleCommand(catalog: Catalog, selected: string[]) {
	const scopes = selectionScopes(ui, catalog, selected);
	const services = new Set<string>();
	const flags: string[] = [];
	const extra: string[] = [];
	for (const id of normalizeGoogle(selected)) {
		const [service, level] = id.split(':');
		if (service === 'gmail') {
			services.add('gmail');
			flags.push('--gmail-scope', GMAIL[level].mode);
			if (GMAIL[level].compose) extra.push(g('gmail.compose')[0]);
		} else if (level === 'read')
			extra.push(...catalog.rows.find((r) => r.id === service)!.levels[0].scopes);
		else {
			services.add(service);
			if (service === 'photos') flags.push('--photos-scope', 'append');
		}
	}
	// gog requires at least one service; people is its OpenID profile scope.
	if (!services.size) {
		services.add('people');
		scopes.push('profile');
	}
	if (extra.length) flags.push('--extra-scopes', [...new Set(extra)].join(','));
	return { args: ['--services', [...services].join(','), ...flags], scopes };
}
