import { execFile } from 'node:child_process';
import { executable, readiness, TOOLS } from './cli.js';
import type { Provider } from './model.js';
export type ToolStatus =
	| { state: 'installed'; version: string }
	| { state: 'not_installed' | 'check_failed' | 'unrecognized_version'; version: null };
export type IntegrationStatus = {
	id: Provider;
	name: string;
	cli: string;
	tool: ToolStatus;
	qualified_version: string;
	setup: { state: string; message: string };
};
export type Overview = { checked_at: string; integrations: IntegrationStatus[] };
export function toolStatus(binary: string): Promise<ToolStatus> {
	return new Promise((resolve) =>
		execFile(
			binary,
			['--version'],
			{ timeout: 5000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true },
			(error, stdout) => {
				if (error) {
					resolve({
						state:
							(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_installed' : 'check_failed',
						version: null
					});
					return;
				}
				const match = stdout
					.trim()
					.match(
						/^(?:m365cli version )?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?: \([^\r\n]*\))?$/
					);
				resolve(
					match
						? { state: 'installed', version: match[1] }
						: { state: 'unrecognized_version', version: null }
				);
			}
		)
	);
}
export const googleToolStatus = () => toolStatus('gog');
export async function overview(dir = ''): Promise<Overview> {
	const integrations = await Promise.all(
		(['google', 'microsoft'] as Provider[]).map(async (id) => ({
			id,
			name: id === 'google' ? 'Google' : 'Microsoft',
			cli: TOOLS[id].binary,
			tool: await toolStatus(executable(dir, id)),
			qualified_version: TOOLS[id].version,
			setup: readiness(dir, id)
		}))
	);
	return { checked_at: new Date().toISOString(), integrations };
}
