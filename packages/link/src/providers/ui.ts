// Browser-safe registry of integrations, in page order.
import google from './google/ui.js';
import microsoft from './microsoft/ui.js';
import hubspot from './hubspot/ui.js';
import dropbox from './dropbox/ui.js';
import zoominfo from './zoominfo/ui.js';
import type { ProviderUi } from './types.js';

export const PROVIDER_UI: ProviderUi[] = [google, microsoft, hubspot, dropbox, zoominfo];
export const PROVIDER_IDS = PROVIDER_UI.map((p) => p.id);
export function uiOf(id: string): ProviderUi {
	const p = PROVIDER_UI.find((p) => p.id === id);
	if (!p) throw new Error('Unknown integration.');
	return p;
}
export const BASE_SCOPES: Record<string, string[]> = Object.fromEntries(
	PROVIDER_UI.map((p) => [p.id, p.baseline])
);
