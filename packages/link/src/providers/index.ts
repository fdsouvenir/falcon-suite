// Server registry of integration adapters, in page order.
import google from './google/index.js';
import microsoft from './microsoft/index.js';
import type { ProviderModule } from './types.js';

export const PROVIDERS: ProviderModule[] = [google, microsoft];
export function provider(id: string): ProviderModule {
	const p = PROVIDERS.find((p) => p.ui.id === id);
	if (!p) throw new Error('Unknown integration.');
	return p;
}
