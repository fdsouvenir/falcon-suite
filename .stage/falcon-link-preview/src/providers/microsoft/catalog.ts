import type { Catalog, Level, Row } from '../../model.js';

const strings = (v: unknown) =>
	Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length <= 512)
		? (v as string[])
		: null;

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
	'mail-write': 'Read, organize, write drafts and delete email, including permanent deletion.'
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
