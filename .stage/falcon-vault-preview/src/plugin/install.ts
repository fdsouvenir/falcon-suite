import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';

/**
 * OpenClaw materializes the resolver (spec §5) only if no directory between the plugin root and
 * the script is group- or world-writable. An installer running under a permissive umask (002 is
 * common) leaves the plugin root group-writable, and then every Vault SecretRef fails closed. The
 * service drops group and world write from those two directories, which belong to this plugin, so
 * the next `openclaw secrets reload` (or Gateway start) can run it. Returns what it changed.
 */
export function secureResolverPath(root: string | undefined): string[] {
	if (!root || !path.isAbsolute(root)) return [];
	const changed: string[] = [];
	for (const dir of [root, path.join(root, 'bin')]) {
		const s = lstatSync(dir, { throwIfNoEntry: false });
		if (!s?.isDirectory() || s.isSymbolicLink()) continue;
		if (typeof process.getuid === 'function' && s.uid !== process.getuid()) continue;
		if (s.mode & 0o022) {
			chmodSync(dir, s.mode & 0o7755);
			changed.push(dir);
		}
	}
	return changed;
}
