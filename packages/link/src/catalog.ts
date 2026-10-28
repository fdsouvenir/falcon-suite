import { normalizeGoogle, selectionScopes, type Catalog, type Level, type Row } from './model.js';

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
	'gmail:compose': 'Read email, write drafts and send email.',
	'gmail:full': 'Read, send, organize and delete (to trash) email, and change mail settings.',
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
			'gmail:read-send': { label: 'Email: Read and send', scopes: GMAIL['read-send'].scopes },
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
	const scopes = selectionScopes('google', catalog, selected);
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

// Microsoft: rows come from `m365cli auth workloads --json`. New connections are offered
// only workloads that are not compatibility bundles; bundles stay valid for saved accounts.
const MICROSOFT_LABELS: Record<string, string> = {
	mail: 'Email',
	calendar: 'Calendar',
	contacts: 'Contacts',
	tasks: 'Tasks',
	onedrive: 'OneDrive files',
	excel: 'Excel workbooks',
	groups: 'Groups'
};
const MICROSOFT_DESCRIPTIONS: Record<string, string> = {
	'mail-write': 'Read, organize and delete (to Deleted Items) email, and write drafts.'
};
type Workload = {
	id: string;
	service: string;
	label: string;
	access: string;
	scopes: string[];
	personal: boolean;
	tenant_admin_consent: boolean;
	compatibility_bundle: boolean;
	notes: string;
};
export function microsoftCatalog(workloads: unknown): Catalog {
	if (!Array.isArray(workloads)) throw new Error('Microsoft workloads are unavailable.');
	const valid = (workloads as Partial<Workload>[]).filter(
		(w): w is Workload =>
			typeof w?.id === 'string' &&
			/^[a-z0-9-]{1,32}$/.test(w.id) &&
			typeof w.service === 'string' &&
			/^[a-z0-9-]{1,32}$/.test(w.service) &&
			typeof w.label === 'string' &&
			typeof w.access === 'string' &&
			!!strings(w.scopes)?.length
	);
	const rows: Row[] = [];
	const saved: Catalog['saved'] = {};
	for (const service of [...new Set(valid.map((w) => w.service))]) {
		const offered = valid.filter((w) => w.service === service && w.compatibility_bundle !== true);
		const level = (w: Workload): Level => ({
			id: w.id,
			label: w.access === 'read' ? 'Read' : w.access === 'send' ? w.label : 'Read and change',
			description: MICROSOFT_DESCRIPTIONS[w.id] ?? (w.notes || w.label),
			scopes: w.scopes
		});
		const levels = offered
			.filter((w) => w.access !== 'send')
			.sort((a, b) => Number(a.access !== 'read') - Number(b.access !== 'read'))
			.map(level);
		const addon = offered.find((w) => w.access === 'send');
		if (!levels.length && !addon) continue;
		rows.push({
			id: service,
			label: MICROSOFT_LABELS[service] ?? service,
			group: 'main',
			levels,
			...(addon ? { addon: level(addon) } : {}),
			...(offered.every((w) => w.personal === false) ? { work_only: true } : {}),
			...(offered.some((w) => w.tenant_admin_consent === true) ? { admin_consent: true } : {})
		});
	}
	for (const w of valid)
		if (w.compatibility_bundle === true) saved[w.id] = { label: w.label, scopes: w.scopes };
	return { rows, saved };
}
export const workOnly = (catalog: Catalog, selected: string[]) =>
	catalog.rows.some(
		(r) =>
			r.work_only &&
			[...r.levels, ...(r.addon ? [r.addon] : [])].some((l) => selected.includes(l.id))
	);
