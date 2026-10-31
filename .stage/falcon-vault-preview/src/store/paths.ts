// Locations, field names and the Reference grammar (spec §3, §5). Browser-safe: no Node imports.

/** The KeePassXC fields a Reference can name. `Path` alone means Password. */
export const FIELDS = ['Password', 'UserName', 'URL', 'Notes', 'Title'] as const;
export type Field = (typeof FIELDS)[number];

/** The secret-provider integration declared in openclaw.plugin.json (`secretProviderIntegrations`). */
export const INTEGRATION_ID = 'falcon-vault';
/** The provider alias a new setup gets, when config names none of its own (spec §14.2). */
export const DEFAULT_PROVIDER_ALIAS = 'falcon-vault';

/**
 * Fixed locations under the Gateway's state directory (spec §3). The database and key are the
 * operator's; the plugin's own data folder is always `falcon-vault`, whatever the plugin id, so a
 * preview build and production share one lock around the one database.
 */
export const DB_FILE = 'passwords.kdbx';
export const KEY_FILE = 'vault.key';
export const DATA_DIR = 'falcon-vault';
export const LOCK_FILE = 'vault.lock';
export const AUDIT_FILE = 'audit.db';

/** OpenClaw's exec SecretRef id grammar (gateway/secrets/secretref-contract.md). */
const EXEC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const FIELD_SUFFIX = new RegExp(`^(.*):(${FIELDS.join('|')})$`);

/** `Path` or `Path:Field`, split. The id is not validated here. */
export function parseReference(id: string): { path: string; field: Field } {
	const m = FIELD_SUFFIX.exec(id);
	return m ? { path: m[1], field: m[2] as Field } : { path: id, field: 'Password' };
}

/** Stable config id from the existing KeePass UUID (base64url, without padding). */
export const referenceFor = (uuid: string): string =>
	`entry/${uuid.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;

/** UUID-reference shape; other ids retain their legacy path meaning. */
export const isEntryReference = (path: string): boolean => /^entry\/[A-Za-z0-9_-]{22}$/.test(path);

/** Whether an id is a well-formed Reference: exec grammar, and a known field if one is named. */
export function validReference(id: string): boolean {
	if (!EXEC_ID.test(id)) return false;
	if (id.split('/').some((s) => s === '.' || s === '..')) return false;
	return true;
}

/** Join group names and a title into a path. The root group is not part of it. */
export const joinPath = (...parts: string[]) => parts.filter((p) => p !== '').join('/');

/** The group part of an entry path (`Services/Cloudflare/API` → `Services/Cloudflare`). */
export const groupOf = (path: string) =>
	path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
