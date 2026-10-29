#!/usr/bin/env node
// Operator-only, local provisioning. No UI operation accepts application configuration.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
	const allowed = [
		'google_credentials_file',
		'microsoft_client_id',
		'microsoft_tenant',
		'microsoft_client_secret_file',
		'dropbox_app_key',
		'callback'
	];
	if (Object.keys(input).some((k) => !allowed.includes(k)))
		throw new Error('Unknown provisioning field.');
	const next = { ...existing, ...input };
	if (next.google_credentials_file) {
		if (!path.isAbsolute(next.google_credentials_file))
			throw new Error('Google credential file must be an absolute path.');
		const stat = statSync(next.google_credentials_file);
		if ((stat.mode & 0o077) !== 0)
			throw new Error('Google credential file must be private (0600).');
		const raw = JSON.parse(readFileSync(next.google_credentials_file, 'utf8'));
		const c = next.callback ? raw.web : raw.installed;
		if (!c?.client_id || !c?.client_secret)
			throw new Error(
				next.callback
					? 'Google web application credentials are required for the callback service.'
					: 'Google desktop application credentials are required.'
			);
	}
	if (next.microsoft_client_id && !/^[a-fA-F0-9-]{36}$/.test(next.microsoft_client_id))
		throw new Error('Invalid Microsoft application ID.');
	if (next.microsoft_tenant && !/^[a-zA-Z0-9.-]{1,255}$/.test(next.microsoft_tenant))
		throw new Error('Invalid Microsoft tenant.');
	if (next.dropbox_app_key && !/^[a-z0-9]{8,32}$/.test(next.dropbox_app_key))
		throw new Error('Invalid Dropbox app key.');

	if (next.microsoft_client_secret_file) {
		if (
			!path.isAbsolute(next.microsoft_client_secret_file) ||
			(statSync(next.microsoft_client_secret_file).mode & 0o077) !== 0 ||
			!readFileSync(next.microsoft_client_secret_file, 'utf8').trim()
		)
			throw new Error('Microsoft secret file must be private, nonempty and absolute.');
	}
	if (next.callback) {
		const c = next.callback;
		const u = new URL(c.url);
		if (
			Object.keys(c).some((k) => !['url', 'office', 'token_file', 'version'].includes(k)) ||
			u.protocol !== 'https:' ||
			u.username ||
			u.password ||
			u.pathname !== '/' ||
			u.search ||
			u.hash ||
			!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.office) ||
			!/^\d+\.\d+\.\d+$/.test(c.version) ||
			!path.isAbsolute(c.token_file) ||
			(statSync(c.token_file).mode & 0o077) !== 0 ||
			!/^[A-Za-z0-9_-]{43,128}$/.test(readFileSync(c.token_file, 'utf8').trim())
		)
			throw new Error(
				'Callback configuration must identify an HTTPS service, pinned version, Office and private token file.'
			);
	}
	// Native Gateway config supplies each CLI's keyring password to Link and normal agent exec.
	// Existing values are never overwritten or rotated.
	const configPath =
		process.env.OPENCLAW_CONFIG_PATH || path.join(path.dirname(dir), 'openclaw.json');
	const config = JSON.parse(readFileSync(configPath, 'utf8'));
	const vars = { ...config.env, ...config.env?.vars };
	const present = (name) => typeof vars[name] === 'string' && vars[name].length > 0;
	let accounts = [];
	try {
		const data = JSON.parse(readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
		accounts = Array.isArray(data?.accounts) ? data.accounts : [];
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	const pluginId = path.basename(dir);
	if (!['falcon-link', 'falcon-link-preview'].includes(pluginId))
		throw new Error('Provision the named Falcon Link plugin state directory.');
	const settings = [];
	for (const [name, provider, label] of [
		['GOG_KEYRING_PASSWORD', 'google', 'Google'],
		['M365CLI_KEYRING_PASSWORD', 'microsoft', 'Microsoft']
	]) {
		if (present(name)) continue;
		if (present('FALCON_LINK_KEYRING_PASSWORD')) {
			settings.push({ path: 'env.vars.' + name, value: vars.FALCON_LINK_KEYRING_PASSWORD });
			continue;
		}
		if (accounts.some((a) => a?.provider === provider && !a.external && a.state !== 'disconnected'))
			throw new Error(
				`Existing ${label} accounts require their original keyring password; no new password generated.`
			);
		settings.push({ path: 'env.vars.' + name, value: randomBytes(32).toString('base64url') });
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const batch = path.join(dir, `.environment-${randomUUID()}.json`);
	writeFileSync(
		batch,
		JSON.stringify([
			...settings,
			{ path: `plugins.entries.${pluginId}.hooks.allowConversationAccess`, value: true }
		]),
		{ mode: 0o600 }
	);
	try {
		execFileSync('openclaw', ['config', 'set', '--batch-file', batch], {
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 45000
		});
	} catch {
		throw new Error(
			'Office environment provisioning failed; private CLI diagnostics were not exposed.'
		);
	} finally {
		const { unlinkSync } = await import('node:fs');
		unlinkSync(batch);
	}

	const tmp = path.join(dir, `.provision-${randomUUID()}`);
	writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
	renameSync(tmp, target);
	console.log(
		'Operator configuration merged. GOG_KEYRING_PASSWORD and M365CLI_KEYRING_PASSWORD are set in the Office environment and the account hook is enabled. Restart the Gateway and verify through the agent command tool.'
	);
} catch (e) {
	console.error(e instanceof SyntaxError ? 'Invalid configuration JSON.' : e.message);
	process.exit(1);
}
