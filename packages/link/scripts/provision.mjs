#!/usr/bin/env node
// Operator-only, local provisioning. No UI operation accepts application configuration.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const [dir, source] = process.argv.slice(2);
if (!dir || !source || !path.isAbsolute(dir) || !path.isAbsolute(source)) {
	console.error(
		'Usage: node scripts/provision.mjs <absolute-plugin-state-directory> <absolute-config-json>'
	);
	process.exit(2);
}
try {
	const input = JSON.parse(readFileSync(source, 'utf8'));
	const target = path.join(dir, 'provision.json');
	let existing = {};
	try {
		existing = JSON.parse(readFileSync(target, 'utf8'));
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	const allowed = ['google_credentials_file', 'microsoft_client_id', 'microsoft_tenant'];
	if (Object.keys(input).some((k) => !allowed.includes(k)))
		throw new Error('Unknown provisioning field.');
	const next = { ...existing, ...input };
	if (next.google_credentials_file) {
		if (!path.isAbsolute(next.google_credentials_file))
			throw new Error('Google credential file must be an absolute path.');
		const stat = statSync(next.google_credentials_file);
		if ((stat.mode & 0o077) !== 0)
			throw new Error('Google credential file must be private (0600).');
		const c = JSON.parse(readFileSync(next.google_credentials_file, 'utf8')).installed;
		if (!c?.client_id || !c?.client_secret)
			throw new Error('Google desktop application credentials are required.');
	}
	if (next.microsoft_client_id && !/^[a-fA-F0-9-]{36}$/.test(next.microsoft_client_id))
		throw new Error('Invalid Microsoft application ID.');
	if (next.microsoft_tenant && !/^[a-zA-Z0-9.-]{1,255}$/.test(next.microsoft_tenant))
		throw new Error('Invalid Microsoft tenant.');
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = path.join(dir, `.provision-${randomUUID()}`);
	writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
	renameSync(tmp, target);
	console.log(
		'Operator configuration merged. Readiness also requires FALCON_LINK_KEYRING_PASSWORD in the Gateway environment.'
	);
} catch (e) {
	console.error(e instanceof SyntaxError ? 'Invalid configuration JSON.' : e.message);
	process.exit(1);
}
