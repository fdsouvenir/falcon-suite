import { INTEGRATION_ID, parseReference, type Field } from './paths.js';

/**
 * Usages (spec §5): places in OpenClaw config whose SecretRef resolves from an entry. Never stored;
 * computed from the live config each time an entry is shown. Browser-safe.
 */
export type Usage = { config_path: string; field: Field; label: string };

type Ref = { source: string; provider?: string; id: string };
const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** The provider aliases in config that resolve through this plugin's integration. */
export function vaultProviders(config: unknown, pluginId: string): string[] {
	const providers = isRecord(config) && isRecord(config.secrets) ? config.secrets.providers : null;
	if (!isRecord(providers)) return [];
	return Object.entries(providers)
		.filter(([, p]) => {
			const owner = isRecord(p) && p.source === 'exec' ? p.pluginIntegration : null;
			return (
				isRecord(owner) && owner.pluginId === pluginId && owner.integrationId === INTEGRATION_ID
			);
		})
		.map(([alias]) => alias);
}

/** A config path as people read it: `models.providers.anthropic.apiKey`, `x.list[0]`, `a["b.c"]`. */
function configPath(parts: (string | number)[]): string {
	let out = '';
	for (const p of parts)
		out +=
			typeof p === 'number'
				? `[${p}]`
				: /^[A-Za-z_$][\w$-]*$/.test(p)
					? `${out ? '.' : ''}${p}`
					: `[${JSON.stringify(p)}]`;
	return out;
}

/** "anthropic model provider — apiKey": what the setting is, from where it sits. */
function labelFor(parts: (string | number)[]): string {
	const s = parts.map(String);
	const last = s[s.length - 1];
	const named = (kind: string, i: number) => (s[i] ? `${s[i]} ${kind} — ${last}` : last);
	if (s[0] === 'models' && s[1] === 'providers') return named('model provider', 2);
	if (s[0] === 'plugins' && s[1] === 'entries') return named('plugin', 2);
	if (s[0] === 'skills' && s[1] === 'entries') return named('skill', 2);
	if (s[0] === 'channels') return named('channel', 1);
	if (s[0] === 'tools') return named('tool', 1);
	return s.length > 1 ? `${s[s.length - 2]} — ${last}` : last;
}

/** Every SecretRef in config that resolves through Vault, with where it is and which entry it names. */
export function vaultReferences(
	config: unknown,
	pluginId: string
): { config_path: string; path: string; field: Field; label: string }[] {
	const aliases = new Set(vaultProviders(config, pluginId));
	if (!aliases.size || !isRecord(config)) return [];
	const secrets = isRecord(config.secrets) ? config.secrets : {};
	const defaults = isRecord(secrets.defaults) ? secrets.defaults : {};
	const defaultExec = typeof defaults.exec === 'string' ? defaults.exec : 'default';
	const out: { config_path: string; path: string; field: Field; label: string }[] = [];
	const seen = new Set<unknown>();
	const walk = (node: unknown, at: (string | number)[]) => {
		if (typeof node !== 'object' || node === null || seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) return node.forEach((v, i) => walk(v, [...at, i]));
		const ref = node as Partial<Ref>;
		if (ref.source === 'exec' && typeof ref.id === 'string') {
			if (aliases.has(ref.provider ?? defaultExec)) {
				const { path, field } = parseReference(ref.id);
				out.push({ config_path: configPath(at), path, field, label: labelFor(at) });
			}
			return;
		}
		for (const [k, v] of Object.entries(node)) {
			if (at.length === 1 && at[0] === 'secrets' && k === 'providers') continue;
			walk(v, [...at, k]);
		}
	};
	walk(config, []);
	return out;
}

/** The Usages of the entry at `path`. */
export const usagesOf = (config: unknown, pluginId: string, path: string): Usage[] =>
	vaultReferences(config, pluginId)
		.filter((r) => r.path === path)
		.map(({ config_path, field, label }) => ({ config_path, field, label }));
