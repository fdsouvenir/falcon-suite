// An integration ID from the provider registry (src/providers).
export type Provider = string;
export type Owner = { kind: 'human' | 'agent'; id: string; name: string };
export type Purpose = { kind: 'work' | 'personal' | 'other'; label?: string };
export type Account = {
	id: string;
	provider: Provider;
	owner: Owner | null;
	purpose: Purpose | null;
	email: string | null;
	// The person's name where the provider reports one.
	display_name?: string | null;
	provider_id: string | null;
	requested: string[];
	recorded_scopes?: string[] | null;
	granted_scopes: string[] | null;
	grant?: { status: 'known' | 'unknown'; selected_not_granted: string[] | null };
	audience?: 'consumer' | 'enterprise';
	// How the account signs in, where a provider offers more than one way.
	auth?: 'oauth' | 'service_key';
	external?: { selection: string; client?: string; client_id?: string };
	state: 'discovered' | 'pending' | 'connected' | 'check_failed' | 'disconnected' | 'failed';
	checked_at: string | null;
	created_at: string;
	connection_error?: { code: string; message: string };
};
// One permission row per service. Levels are a single choice (Off is implicit); an addon
// is an independent choice in the same row (Microsoft sends email separately). An addon with
// `addon_requires` is offered only while that level is chosen.
export type Level = { id: string; label: string; description: string; scopes: string[] };
export type Row = {
	id: string;
	label: string;
	// 'main' rows are always shown; other groups are collapsed sections.
	group: string;
	levels: Level[];
	addon?: Level;
	addon_requires?: string;
	// What the row covers, shown while no level is chosen.
	description?: string;
	note?: string;
	work_only?: boolean;
	admin_consent?: boolean;
};
// `saved` lists selection IDs from earlier versions that existing accounts keep using.
// `groups` titles collapsed sections (default "More <provider> services"); `chosen_note` shows
// while any of the section's rows is on. `technical` adds lines to Technical details.
export type Catalog = {
	rows: Row[];
	saved: Record<string, { label: string; scopes: string[] }>;
	groups?: Record<string, { title: string; note?: string; chosen_note?: string }>;
	technical?: string[];
};
// How a provider's permission choices map to scopes. `normalize` translates selections
// saved by earlier versions; `offer` maps saved selections to the current form's choices.
export type Permissions = {
	baseline: string[];
	normalize?: (selected: string[]) => string[];
	offer?: (selected: string[]) => string[];
};
const levelOf = (catalog: Catalog, id: string) => {
	for (const row of catalog.rows) {
		const level = row.levels.find((l) => l.id === id);
		if (level) return { row, level, addon: false };
		if (row.addon?.id === id) return { row, level: row.addon, addon: true };
	}
	return undefined;
};
export function selectionScopes(p: Permissions, catalog: Catalog, selected: string[]) {
	const ids = p.normalize ? p.normalize(selected) : selected;
	const rows = new Set<string>();
	const scopes = [...p.baseline];
	if (!ids.length || new Set(ids).size !== ids.length)
		throw new Error('Select supported permissions.');
	for (const id of ids) {
		const found = levelOf(catalog, id);
		if (found && !found.addon) {
			if (rows.has(found.row.id)) throw new Error('Select one level per service.');
			rows.add(found.row.id);
		}
		if (found?.addon && found.row.addon_requires && !ids.includes(found.row.addon_requires))
			throw new Error('Select supported permissions.');
		const values = found?.level.scopes ?? catalog.saved[id]?.scopes;
		if (!values) throw new Error('Select supported permissions.');
		scopes.push(...values);
	}
	return [...new Set(scopes)];
}
// Choices to preselect when someone changes an existing account's access.
export function offeredSelection(p: Permissions, catalog: Catalog, selected: string[]) {
	const ids = p.offer ? p.offer(selected) : selected;
	return [...new Set(ids)].filter((id) => levelOf(catalog, id));
}
// Plain-words description of a selection, by service row.
export function describeSelection(p: Permissions, catalog: Catalog, selected: string[]) {
	return (p.normalize ? p.normalize(selected) : selected).flatMap((id) => {
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
