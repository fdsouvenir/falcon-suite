import type { Account } from './model.js';
import { PROVIDERS } from './providers/index.js';

// Escape table delimiters/control characters in user/provider-supplied facts.
const cell = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').replaceAll('|', '\\|');
export function accountBrief(accounts: Account[], unavailable: string[] = []): string {
	const clis = PROVIDERS.map((p) => p.tool.binary);
	const lines = [
		'Falcon Link integrations and configured accounts',
		`falcon_link_accounts lists accounts; with account_id it returns the CLI account arguments and storage environment for that account. ${clis.slice(0, -1).join(', ')} and ${clis.at(-1)} are on the normal PATH. The keyring password variables are already present in the command environment.`
	];
	for (const p of PROVIDERS) {
		const provider = p.ui.id;
		lines.push('', p.brief.heading);
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
				const scopes = p.brief.scopes(a);
				const recorded =
					a.granted_scopes === null && a.recorded_scopes?.length ? ' (recorded)' : '';
				lines.push(
					[
						p.brief.identity?.(a) ?? a.email ?? 'unknown',
						a.owner?.name ?? 'unassigned',
						a.purpose
							? a.purpose.kind === 'other'
								? a.purpose.label!
								: a.purpose.kind
							: 'unassigned',
						scopes + recorded + attention
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
