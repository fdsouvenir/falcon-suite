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
	grant?: { status: 'known' | 'unknown'; selected_not_granted: string[] | null };
	audience?: 'consumer' | 'enterprise';
	external?: { selection: string; client?: string; client_id?: string };
	state: 'discovered' | 'pending' | 'connected' | 'check_failed' | 'disconnected' | 'failed';
	checked_at: string | null;
	created_at: string;
	connection_error?: { code: string; message: string };
};
// One permission row per service. Levels are a single choice (Off is implicit); an addon
// is an independent choice in the same row (Microsoft sends email separately).
export type Level = { id: string; label: string; description: string; scopes: string[] };
export type Row = {
	id: string;
	label: string;
	group: 'main' | 'more';
	levels: Level[];
	addon?: Level;
	note?: string;
	work_only?: boolean;
	admin_consent?: boolean;
};
// `saved` lists selection IDs from earlier versions that existing accounts keep using.
export type Catalog = { rows: Row[]; saved: Record<string, { label: string; scopes: string[] }> };
export const BASE_SCOPES: Record<Provider, string[]> = {
	google: ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'],
	microsoft: ['openid', 'profile', 'offline_access', 'User.Read']
};
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
const levelOf = (catalog: Catalog, id: string) => {
	for (const row of catalog.rows) {
		const level = row.levels.find((l) => l.id === id);
		if (level) return { row, level, addon: false };
		if (row.addon?.id === id) return { row, level: row.addon, addon: true };
	}
	return undefined;
};
export function selectionScopes(provider: Provider, catalog: Catalog, selected: string[]) {
	const ids = provider === 'google' ? normalizeGoogle(selected) : selected;
	const rows = new Set<string>();
	const scopes = [...BASE_SCOPES[provider]];
	if (!ids.length || new Set(ids).size !== ids.length)
		throw new Error('Select supported permissions.');
	for (const id of ids) {
		const found = levelOf(catalog, id);
		if (found && !found.addon) {
			if (rows.has(found.row.id)) throw new Error('Select one level per service.');
			rows.add(found.row.id);
		}
		const values = found?.level.scopes ?? catalog.saved[id]?.scopes;
		if (!values) throw new Error('Select supported permissions.');
		scopes.push(...values);
	}
	return [...new Set(scopes)];
}
// Choices to preselect when someone changes an existing account's access.
const MICROSOFT_EQUIVALENTS: Record<string, string[]> = {
	mail: ['mail-read', 'mail-send'],
	calendar: ['calendar-write'],
	contacts: ['contacts-write'],
	tasks: ['tasks-write'],
	onedrive: ['onedrive-write']
};
export function offeredSelection(provider: Provider, catalog: Catalog, selected: string[]) {
	const ids =
		provider === 'google'
			? normalizeGoogle(selected).map((id) =>
					['gmail:read-send', 'gmail:read-compose'].includes(id) ? 'gmail:compose' : id
				)
			: selected.flatMap((id) => MICROSOFT_EQUIVALENTS[id] ?? [id]);
	return [...new Set(ids)].filter((id) => levelOf(catalog, id));
}
// Plain-words description of a selection, by service row.
export function describeSelection(provider: Provider, catalog: Catalog, selected: string[]) {
	return (provider === 'google' ? normalizeGoogle(selected) : selected).flatMap((id) => {
		const found = levelOf(catalog, id);
		if (!found) return catalog.saved[id] ? [catalog.saved[id].label] : [];
		return [found.addon ? found.level.label : `${found.row.label}: ${found.level.label}`];
	});
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
