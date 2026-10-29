import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { executable } from './tools.js';
import { latestRelease, releaseCheckedAt } from './install.js';
import { PROVIDERS } from './providers/index.js';
import { compareVersions } from './versions.js';
export type ToolStatus =
	| { state: 'installed'; version: string }
	| { state: 'not_installed' | 'check_failed' | 'unrecognized_version'; version: null };
export type IntegrationStatus = {
	id: string;
	name: string;
	cli: string;
	path: string | null;
	tool: ToolStatus;
	latest_version: string | null;
	checked_at: string | null;
	update_available: boolean;
	minimum_version: string;
	below_minimum: boolean;
	installable: boolean;
	managed: boolean;
	setup: { state: string; message: string };
};
export type Overview = { checked_at: string; integrations: IntegrationStatus[] };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function toolStatus(binary: string, prefix = ''): Promise<ToolStatus> {
	const pattern = new RegExp(
		`^(?:${escape(prefix)})?(v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)(?: \\([^\\r\\n]*\\))?$`
	);
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
				const match = stdout.trim().match(pattern);
				resolve(
					match
						? { state: 'installed', version: match[1] }
						: { state: 'unrecognized_version', version: null }
				);
			}
		)
	);
}
// Link can update only a CLI it installed: a private copy, or the PATH command whose bytes
// still match Link's installation receipt.
const digests = new Map<string, { key: string; sha256: string }>();
function linkInstalled(dir: string, provider: string, binary: string) {
	if (!dir) return false;
	if (binary.startsWith(path.join(dir, 'tools') + path.sep)) return true;
	try {
		const receipt = JSON.parse(
			readFileSync(path.join(dir, 'tools', provider, 'path-install.json'), 'utf8')
		);
		if (receipt.path !== binary) return false;
		const stat = statSync(binary);
		const key = `${stat.size}:${stat.mtimeMs}`;
		let cached = digests.get(binary);
		if (cached?.key !== key) {
			cached = { key, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex') };
			digests.set(binary, cached);
		}
		return cached.sha256 === receipt.binary_sha256;
	} catch {
		return false;
	}
}
export async function overview(dir = ''): Promise<Overview> {
	const integrations = await Promise.all(
		PROVIDERS.map(async (p) => {
			const id = p.ui.id;
			const binary = executable(dir, id);
			const [tool, release] = await Promise.all([
				toolStatus(binary, p.tool.version_prefix),
				latestRelease(id)
			]);
			const installed = tool.state === 'installed' ? tool.version : null;
			const latest = release ? release.tag_name.slice(1) : null;
			return {
				id,
				name: p.ui.name,
				cli: p.tool.binary,
				path: path.isAbsolute(binary) ? binary : null,
				tool,
				latest_version: latest,
				checked_at: releaseCheckedAt(id),
				update_available: !!installed && !!latest && (compareVersions(latest, installed) ?? 0) > 0,
				minimum_version: p.tool.minimum,
				below_minimum: !!installed && (compareVersions(installed, p.tool.minimum) ?? 0) < 0,
				installable: process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch),
				managed: !!installed && linkInstalled(dir, id, binary),
				setup: p.readiness(dir)
			};
		})
	);
	return { checked_at: new Date().toISOString(), integrations };
}
