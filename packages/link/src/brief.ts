import type { Account, Provider } from './model.js';

// Escape table delimiters/control characters in user/provider-supplied facts.
const cell = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').replaceAll('|', '\\|');
const googleScopes: Record<string, string> = {
	'gmail.readonly': 'Gmail: read',
	'gmail.send': 'Gmail: send',
	'gmail.compose': 'Gmail: drafts/send',
	'gmail.modify': 'Gmail: read/modify/send',
	'calendar.readonly': 'Calendar: read',
	calendar: 'Calendar: read/write',
	'drive.readonly': 'Drive: read',
	drive: 'Drive: read/write',
	'drive.file': 'Drive: app-selected files',
	'contacts.readonly': 'Contacts: read',
	'contacts.other.readonly': 'Other contacts: read',
	'directory.readonly': 'Directory: read',
	contacts: 'Contacts: read/write',
	spreadsheets: 'Sheets: read/write',
	documents: 'Docs: read/write',
	'gmail.settings.basic': 'Gmail: manage basic settings',
	'gmail.settings.sharing': 'Gmail: manage sharing settings',
	email: 'Identity: email',
	openid: 'Identity: OpenID',
	'userinfo.email': 'Identity: email',
	'userinfo.profile': 'Identity: profile'
};
function scopes(a: Account) {
	const values = a.granted_scopes ?? a.recorded_scopes;
	if (!values?.length) return 'unknown';
	const readable = [
		...new Set(
			values.map((s) => {
				if (a.provider !== 'google') return s;
				const short = s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
				return googleScopes[short] ?? short;
			})
		)
	].join('; ');
	return readable + (a.granted_scopes === null ? ' (recorded)' : '');
}
export function accountBrief(accounts: Account[], unavailable: Provider[] = []): string {
	const lines = ['Falcon Link integrations and configured accounts'];
	for (const provider of ['google', 'microsoft'] as const) {
		lines.push('', provider === 'google' ? 'gogcli' : 'm365cli');
		const rows = accounts.filter((a) => a.provider === provider && a.state !== 'disconnected');
		if (rows.length) {
			lines.push("Email | Owner's profile | Purpose | Scopes");
			for (const a of rows) {
				const attention =
					a.state === 'check_failed'
						? ' — connection check failed'
						: a.state === 'failed'
							? ' — reconnect required'
							: a.state === 'pending'
								? ' — sign-in pending'
								: a.state === 'discovered'
									? ' — not checked'
									: '';
				lines.push(
					[
						a.email ?? 'unknown',
						a.owner?.name ?? 'unassigned',
						a.purpose
							? a.purpose.kind === 'other'
								? a.purpose.label!
								: a.purpose.kind
							: 'unassigned',
						scopes(a) + attention
					]
						.map(cell)
						.join(' | ')
				);
			}
		} else
			lines.push(
				unavailable.includes(provider) ? 'Account inventory unavailable' : 'No configured accounts'
			);
		if (rows.length && unavailable.includes(provider))
			lines.push('Existing-account discovery unavailable');
	}
	return lines.join('\n');
}
