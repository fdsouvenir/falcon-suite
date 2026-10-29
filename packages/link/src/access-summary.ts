import { describeSelection, type Account, type Catalog } from './model.js';
import { PROVIDER_UI } from './providers/ui.js';

// Where one capability covers another, show only the broader one.
const BROADER = [
	['Read, send, organize and delete (to trash) email', 'Read email'],
	['Read, send, organize and delete (to trash) email', 'Send email'],
	['Read, send, organize and delete (to trash) email', 'Create email drafts and send email'],
	['Create email drafts and send email', 'Send email'],
	['Manage calendars and events', 'View calendars and events'],
	['Manage contacts', 'View contacts'],
	['Manage tasks', 'View tasks'],
	['Manage files', 'View files']
];
// Translate known capabilities, not scope names or selected permission IDs, into user-facing text.
function scopeItems(a: Account, values: string[]) {
	const ui = PROVIDER_UI.find((p) => p.id === a.provider);
	const baseline = new Set([
		...(ui?.baseline ?? []),
		'profile',
		'https://www.googleapis.com/auth/userinfo.profile'
	]);
	const items = new Set<string>();
	let additional = false;
	const rest: string[] = [];
	for (const scope of values) {
		if (baseline.has(scope)) continue;
		const key = ui?.access.key ? ui.access.key(scope) : scope;
		const label = ui?.access.labels[key];
		if (label) items.add(label);
		else rest.push(key);
	}
	const described = ui?.access.describe ? ui.access.describe(rest) : [];
	for (const item of described) items.add(item);
	if (rest.length && !ui?.access.describe) additional = true;
	for (const [broad, narrow] of BROADER) if (items.has(broad)) items.delete(narrow);
	if (additional) items.add('Additional permissions');
	return [...items];
}
// Granted access when the provider confirmed it; otherwise what was recorded or selected.
export function accessSummary(a: Account, catalog?: Catalog | null) {
	if (!['connected', 'discovered', 'check_failed'].includes(a.state)) return null;
	const ui = PROVIDER_UI.find((p) => p.id === a.provider);
	if (Array.isArray(a.granted_scopes)) {
		const missing =
			catalog && ui ? describeSelection(ui, catalog, a.grant?.selected_not_granted ?? []) : [];
		return {
			title: 'Access',
			items: scopeItems(a, a.granted_scopes),
			note: [
				a.granted_scopes.length ? '' : 'No account service access.',
				missing.length ? `${ui?.name} didn't grant: ${missing.join(', ')}.` : ''
			]
				.filter(Boolean)
				.join(' ')
		};
	}
	if (a.recorded_scopes?.length)
		return { title: 'Access', items: scopeItems(a, a.recorded_scopes), note: '' };
	const selected = catalog && ui ? describeSelection(ui, catalog, a.requested) : [];
	if (selected.length) return { title: 'Access', items: selected, note: '' };
	return {
		title: 'Access',
		items: [],
		note: ui?.access.unknown?.(a) ?? 'Access details aren’t available for this account.'
	};
}
