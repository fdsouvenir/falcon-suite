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
// Access by service: one row per service with its capabilities. Providers without services
// have a single row without a name.
export type AccessGroup = { service: string | null; items: string[] };
// Translate known capabilities, not scope names or selected permission IDs, into user-facing text.
function scopeItems(a: Account, values: string[]) {
	const ui = PROVIDER_UI.find((p) => p.id === a.provider);
	const baseline = new Set([
		...(ui?.baseline ?? []),
		'profile',
		'https://www.googleapis.com/auth/userinfo.profile'
	]);
	const items = new Set<string>();
	const serviceOf = new Map<string, string | null>();
	let additional = false;
	const rest: string[] = [];
	for (const scope of values) {
		if (baseline.has(scope)) continue;
		const key = ui?.access.key ? ui.access.key(scope) : scope;
		const label = ui?.access.labels[key];
		const service = ui?.access.service?.(key) ?? null;
		if (label) {
			items.add(label);
			serviceOf.set(label, service);
		} else if (service) {
			// A service Link has no words for yet still shows under its own name.
			const other = `${service} access`;
			items.add(other);
			serviceOf.set(other, service);
		} else rest.push(key);
	}
	const described = ui?.access.describe ? ui.access.describe(rest) : [];
	for (const item of described) items.add(item);
	if (rest.length && !ui?.access.describe) additional = true;
	for (const [broad, narrow] of BROADER) if (items.has(broad)) items.delete(narrow);
	if (additional) items.add('Additional permissions');
	const list = [...items];
	return { items: list, groups: group(list, serviceOf, ui?.access.services ?? []) };
}
function group(items: string[], serviceOf: Map<string, string | null>, order: string[]) {
	const groups: AccessGroup[] = [];
	for (const item of items) {
		const service = serviceOf.get(item) ?? null;
		let g = groups.find((x) => x.service === service);
		if (!g) groups.push((g = { service, items: [] }));
		g.items.push(item);
	}
	const rank = (s: string | null) => (s === null ? order.length + 1 : order.indexOf(s));
	return groups.sort((x, y) => rank(x.service) - rank(y.service));
}
const ungrouped = (items: string[]): AccessGroup[] =>
	items.length ? [{ service: null, items }] : [];
// Granted access when the provider confirmed it; otherwise what was recorded or selected.
export function accessSummary(a: Account, catalog?: Catalog | null) {
	if (!['connected', 'discovered', 'check_failed'].includes(a.state)) return null;
	const ui = PROVIDER_UI.find((p) => p.id === a.provider);
	if (Array.isArray(a.granted_scopes)) {
		const missing =
			catalog && ui ? describeSelection(ui, catalog, a.grant?.selected_not_granted ?? []) : [];
		const { items, groups } = scopeItems(a, a.granted_scopes);
		return {
			title: 'Access',
			items,
			groups,
			note: [
				items.length ? '' : 'No account service access.',
				missing.length ? `${ui?.name} didn't grant: ${missing.join(', ')}.` : '',
				ui?.access.note ?? ''
			]
				.filter(Boolean)
				.join(' ')
		};
	}
	if (a.recorded_scopes?.length)
		return {
			title: 'Access',
			...scopeItems(a, a.recorded_scopes),
			note: ui?.access.note ?? ''
		};
	const selected = catalog && ui ? describeSelection(ui, catalog, a.requested) : [];
	if (selected.length)
		return { title: 'Access', items: selected, groups: ungrouped(selected), note: '' };
	return {
		title: 'Access',
		items: [] as string[],
		groups: [] as AccessGroup[],
		note: ui?.access.unknown?.(a) ?? 'Access details aren’t available for this account.'
	};
}
