import { execFile } from 'node:child_process';

export type ToolStatus =
	| { state: 'installed'; version: string }
	| {
			state: 'not_installed' | 'check_failed' | 'unrecognized_version' | 'unqualified';
			version: null;
	  };
export type IntegrationStatus = {
	id: 'google' | 'microsoft';
	name: string;
	cli: string;
	tool: ToolStatus;
	update: { state: 'not_checked' };
	setup: { state: 'unavailable'; message: string };
	accounts: { state: 'not_checked' };
};
export type Overview = { checked_at: string; integrations: IntegrationStatus[] };

/** Read-only, bounded probe of the documented gog executable. Never return raw CLI output. */
export function googleToolStatus(): Promise<ToolStatus> {
	return new Promise((resolve) => {
		execFile(
			'gog',
			['--version'],
			{ timeout: 5000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true },
			(error, stdout) => {
				if (error) {
					// A nonzero exit, permission error or timeout is NOT an absent installation.
					resolve({
						state:
							(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_installed' : 'check_failed',
						version: null
					});
					return;
				}
				// gog's VersionString: version followed by optional build commit/date in parentheses.
				const match = stdout
					.trim()
					.match(/^(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?: \([^\r\n]*\))?$/);
				resolve(
					match
						? { state: 'installed', version: match[1] }
						: { state: 'unrecognized_version', version: null }
				);
			}
		);
	});
}

export async function overview(): Promise<Overview> {
	const google = await googleToolStatus();
	return {
		checked_at: new Date().toISOString(),
		integrations: [
			{
				id: 'google',
				name: 'Google',
				cli: 'gogcli',
				tool: google,
				update: { state: 'not_checked' },
				setup: {
					state: 'unavailable',
					message:
						'Google connection setup is incomplete. Operator provisioning is not available in this development build.'
				},
				accounts: { state: 'not_checked' }
			},
			{
				id: 'microsoft',
				name: 'Microsoft',
				cli: 'm365cli',
				tool: { state: 'unqualified', version: null },
				update: { state: 'not_checked' },
				setup: {
					state: 'unavailable',
					message:
						'Microsoft connection setup is incomplete. Its CLI contract and operator provisioning are not yet qualified.'
				},
				accounts: { state: 'not_checked' }
			}
		]
	};
}
