import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { provider } from './providers/index.js';

export function executable(dir: string, id: string): string {
	const tool = provider(id).tool;
	const normal = path.join(homedir(), '.local', 'bin', tool.binary);
	if ((process.env.PATH ?? '').split(path.delimiter).includes(path.dirname(normal))) {
		try {
			accessSync(normal, constants.X_OK);
			return normal;
		} catch {}
	}
	let version: string | undefined;
	try {
		const current = JSON.parse(readFileSync(path.join(dir, 'tools', id, 'current.json'), 'utf8'));
		if (/^\d+\.\d+\.\d+$/.test(current.version)) version = current.version;
	} catch {}
	const managed = version ? path.join(dir, 'tools', id, version, tool.binary) : '';
	// After migration, removing the normal command must not reactivate a private copy.
	const migrated = existsSync(path.join(dir, 'tools', id, 'path-install.json'));
	if (!migrated && managed && existsSync(managed)) return managed;
	// Prefer normal CLI installations. Private preview paths are legacy fallback only.
	for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!path.isAbsolute(folder)) continue;
		const candidate = path.join(folder, tool.binary);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return tool.binary;
}
