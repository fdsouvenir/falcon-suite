import { createHash } from 'node:crypto';

// Shared checks for accounts found in a CLI's own store.
export const validEmail = (email: unknown): email is string =>
	typeof email === 'string' && email.length <= 254 && /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email);
export const validSelection = (selection: unknown): selection is string =>
	typeof selection === 'string' &&
	!!selection &&
	!selection.startsWith('-') &&
	!/[\x00-\x1f]/.test(selection) &&
	selection.length <= 254;
export const strings = (v: unknown, max = 64) =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length <= max) : [];
// Stable ID for an existing account: its store location and selection.
export const existingId = (identity: unknown[]) =>
	'existing_' + createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
export const inventory = (entries: unknown) => {
	if (!Array.isArray(entries) || entries.length > 500) throw new Error('Inventory unavailable.');
	for (const entry of entries)
		if (!entry || typeof entry !== 'object') throw new Error('Inventory unavailable.');
	return entries as any[];
};
