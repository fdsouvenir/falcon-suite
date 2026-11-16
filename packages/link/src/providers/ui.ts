// Browser-safe registry of integrations, in page order.
import google from './google/ui.js';
import microsoft from './microsoft/ui.js';
import hubspot from './hubspot/ui.js';
import dropbox from './dropbox/ui.js';
import zoominfo from './zoominfo/ui.js';
import type { ProviderUi } from './types.js';

// Kinds of service, in the order the page shows them. Each integration belongs to one.
export const GROUPS = [
	{ id: 'productivity', name: 'Productivity' },
	{ id: 'messaging', name: 'Messaging' },
	{ id: 'crm', name: 'CRM & Sales' },
	{ id: 'payments', name: 'Payments' },
	{ id: 'files', name: 'Files' },
	{ id: 'health', name: 'Health' }
] as const;
export const PROVIDER_UI: ProviderUi[] = [google, microsoft, hubspot, dropbox, zoominfo];
export const PROVIDER_IDS = PROVIDER_UI.map((p) => p.id);
// Groups that have integrations, each with its integrations in page order.
export const PROVIDER_GROUPS = GROUPS.map((g) => ({
	...g,
	providers: PROVIDER_UI.filter((p) => p.group === g.id)
})).filter((g) => g.providers.length);
export function uiOf(id: string): ProviderUi {
	const p = PROVIDER_UI.find((p) => p.id === id);
	if (!p) throw new Error('Unknown integration.');
	return p;
}
export const BASE_SCOPES: Record<string, string[]> = Object.fromEntries(
	PROVIDER_UI.map((p) => [p.id, p.baseline])
);
