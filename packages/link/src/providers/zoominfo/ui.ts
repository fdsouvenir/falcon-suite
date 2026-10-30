import type { ProviderUi } from '../types.js';

// The scopes gtm asks ZoomInfo for on every sign-in (gtm src/oauth.ts). There is nothing to
// choose.
export const SCOPES = ['openid', 'offline_access', 'api:data:mcp', 'zi_mcp', 'profile', 'email'];
// gtm keeps one sign-in, in ~/.config/gtm-ai.
export const ONE_ACCOUNT =
	'ZoomInfo connects one account per Office. To use a different account, remove this one first.';
const ACCESS =
	'Search and enrich companies and contacts, intent signals, scoops and news, and anything else your ZoomInfo plan allows';

const ui: ProviderUi = {
	id: 'zoominfo',
	name: 'ZoomInfo',
	cli: 'gtm',
	baseline: ['openid', 'offline_access', 'profile', 'email'],
	permissions: 'provider',
	consent_note:
		'There is nothing to choose here: every ZoomInfo sign-in gets the same access, and your ZoomInfo plan, credits and admin settings decide what the account can do.',
	connect: 'Sign in with ZoomInfo',
	paste_warning: {
		title:
			"Read this first: after you sign in, ZoomInfo's tab will show an error page. That's expected.",
		steps: [
			'Select “Sign in with ZoomInfo”. ZoomInfo opens in a new tab. Keep this page open.',
			'Sign in to ZoomInfo and allow access.',
			'The ZoomInfo tab then shows a page that “can’t be reached” (for example “This site can’t be reached” or “localhost refused to connect”). This is expected. Nothing is wrong.',
			'Copy the whole address from that tab’s address bar. It starts with http://localhost:9876/callback',
			'Come back to this page and paste it into the box here within 5 minutes.'
		]
	},
	single_account: ONE_ACCOUNT,
	technical: [
		`Scopes: ${SCOPES.join(' ')}`,
		'Sign-in uses the gtm CLI’s own ZoomInfo app (“GTM AI CLI”), which returns to http://localhost:9876/callback on this Office.'
	],
	title: (a) => {
		const id = a.email ?? a.provider_id;
		if (a.display_name) return id ? `${a.display_name} (${id})` : a.display_name;
		return id ? null : 'ZoomInfo account (not checked yet)';
	},
	access: {
		labels: { 'api:data:mcp': ACCESS, zi_mcp: ACCESS },
		note: "Searches and enrichment can use your ZoomInfo account's credits."
	}
};
export default ui;
