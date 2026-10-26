import { createHash } from 'node:crypto';
import { executable, json } from './cli.js';
import type { Account, Provider } from './model.js';

export async function existingAccounts(dir: string, provider: Provider): Promise<Account[]> {
	const out = await json(
		executable(dir, provider),
		provider === 'google'
			? ['auth', 'list', '--json', '--no-input']
			: ['auth', 'status', '--json', '--no-input'],
		process.env,
		5000
	);
	const entries = provider === 'google' ? out.accounts : out.profiles;
	if (!Array.isArray(entries) || entries.length > 500) throw new Error('Inventory unavailable.');
	const accounts: Account[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') throw new Error('Inventory unavailable.');
		// App-only Microsoft profiles are not logged-in human accounts.
		if (provider === 'microsoft' && entry.auth_mode === 'app_only') continue;
		const email = provider === 'google' ? entry.email : entry.username;
		if (
			typeof email !== 'string' ||
			email.length > 254 ||
			!/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email)
		)
			continue;
		const selection = provider === 'google' ? email : entry.name;
		const client = provider === 'google' ? (entry.client ?? 'default') : undefined;
		if (
			typeof selection !== 'string' ||
			!selection ||
			selection.startsWith('-') ||
			/[\x00-\x1f]/.test(selection) ||
			selection.length > 254
		)
			continue;
		if (
			client !== undefined &&
			(typeof client !== 'string' ||
				!/^[a-zA-Z0-9_.-]{1,128}$/.test(client) ||
				client.startsWith('-'))
		)
			continue;
		const identity = JSON.stringify([
			provider,
			process.env.HOME,
			process.env.XDG_CONFIG_HOME,
			provider === 'google' ? process.env.GOG_CONFIG_DIR : undefined,
			provider === 'google' ? process.env.GOG_DATA_DIR : undefined,
			...(provider === 'microsoft' && process.env.M365CLI_CONFIG_DIR
				? [process.env.M365CLI_CONFIG_DIR]
				: []),
			selection,
			client
		]);
		const id = 'existing_' + createHash('sha256').update(identity).digest('hex').slice(0, 32);
		accounts.push({
			id,
			provider,
			email,
			owner: null,
			purpose: null,
			provider_id: null,
			requested: [],
			recorded_scopes:
				provider === 'google' && Array.isArray(entry.scopes)
					? entry.scopes
							.filter((s: unknown): s is string => typeof s === 'string' && s.length <= 512)
							.slice(0, 100)
					: null,
			granted_scopes: null,
			state: 'discovered',
			checked_at: null,
			created_at: new Date().toISOString(),
			external: { selection, ...(client ? { client } : {}) }
		});
	}
	return accounts;
}
