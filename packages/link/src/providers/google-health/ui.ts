import type { ProviderUi } from '../types.js';

const AUTH = 'https://www.googleapis.com/auth/';
// ghcli's read-only Google Health scopes (internal/health/types.go ReadOnlyScopes).
const HEALTH_SCOPES = [
	'activity_and_fitness',
	'health_metrics_and_measurements',
	'location',
	'nutrition',
	'profile',
	'settings',
	'sleep'
].map((s) => `${AUTH}googlehealth.${s}.readonly`);
// Link also asks for the account's identity, to know which Google account signed in.
export const SCOPES = ['openid', 'email', ...HEALTH_SCOPES];

const ui: ProviderUi = {
	id: 'google-health',
	name: 'Google Health',
	group: 'health',
	cli: 'ghcli',
	// Google reports `email` as userinfo.email in the granted scopes.
	baseline: ['openid', 'email', `${AUTH}userinfo.email`],
	permissions: 'provider',
	consent_note:
		"Link asks Google for read-only access to your Google Health data. Google's page lets you choose which kinds of data to allow.",
	connect: 'Sign in with Google',
	revoke: () => ({
		lead: '',
		links: [{ label: "Google's app-access page", href: 'https://myaccount.google.com/connections' }]
	}),
	remove_note: () =>
		'Removing also deletes the health data ghcli archived for this account on this Office.',
	technical: [`Scopes: ${SCOPES.join(' ')}`],
	title: (a) => (a.email ? null : 'Google Health account (not checked yet)'),
	access: {
		key: (scope) => scope.replace(AUTH, ''),
		// Google's own descriptions of these scopes (developers.google.com/health/scopes).
		labels: {
			'googlehealth.activity_and_fitness.readonly': 'View activity and fitness data',
			'googlehealth.health_metrics_and_measurements.readonly':
				'View health metrics and measurements',
			'googlehealth.location.readonly': 'View GPS location recorded during exercise',
			'googlehealth.nutrition.readonly': 'View nutrition data',
			'googlehealth.profile.readonly': 'View Google Health profile',
			'googlehealth.settings.readonly': 'View Google Health settings',
			'googlehealth.sleep.readonly': 'View sleep data'
		}
	}
};
export default ui;
