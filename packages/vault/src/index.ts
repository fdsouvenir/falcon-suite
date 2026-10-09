import {
	defineFeaturePlugin,
	type FeatureInvocationContext
} from 'openclaw/plugin-sdk/feature-plugin';
import { getRuntimeConfigSourceSnapshot } from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { contract } from './contract.js';
import { PLUGIN_ID } from './identity.js';
import { currentHuman } from './plugin/identity.js';
import { secureResolverPath } from './plugin/install.js';
import { currentVault, lastFailure, startVault } from './plugin/runtime.js';
import type { Request } from './store/audit.js';
import type { Actor, EntryFields, VaultOps } from './store/ops.js';
import { DEFAULT_PROVIDER_ALIAS } from './store/paths.js';
import { vaultProviders } from './store/usages.js';

/** Who is calling: the agent behind a tool call, or the signed-in person behind the Control UI. */
function actorFor(context: FeatureInvocationContext): Actor {
	if (context.source === 'tool') {
		const agentId = context.tool.agentId;
		if (!agentId) throw new Error('Falcon Vault needs the calling agent');
		return `agent:${agentId}`;
	}
	const human = currentHuman();
	if (human) return human.id;
	// As in Work: the Gateway admits only operator connections with the operation's scope to a
	// plugin session action, so a caller that reached here is a signed-in operator even when the
	// request scope does not expose the connection. Vault is shared per Gateway (spec §1).
	if (context.source === 'session-action') {
		const scopes = context.action.client?.scopes ?? [];
		if (scopes.some((s) => s.startsWith('operator.'))) return 'person:gateway-owner';
	}
	throw new Error('Falcon Vault needs a signed-in person');
}

/** A retried tool call carries the same id, so its key makes the retry a no-op (spec §10). */
const keyFor = (context: FeatureInvocationContext, given?: string) =>
	given ?? (context.source === 'tool' ? `tool:${context.toolCallId}` : undefined);

const invalid = (reason: string) => ({
	outcome: 'rejected' as const,
	code: 'invalid_input',
	reason
});

/** Turn a Rejection thrown by a read into the tool's answer; anything else propagates. */
async function answer<T>(run: () => Promise<T>) {
	try {
		return await run();
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === 'not_found' || code === 'ambiguous' || code === 'invalid_input')
			return { outcome: 'rejected' as const, code, reason: (error as Error).message };
		throw error;
	}
}

const feature = defineFeaturePlugin({
	contract,
	name: 'Falcon Vault',
	description: 'Your password manager inside OpenClaw, and where config credentials come from.',
	setup(api, events) {
		// The plugin's own directory, read while registering (the API does not answer it later).
		let root: string | undefined;
		try {
			root = api.resolvePath?.('.');
		} catch {
			root = undefined;
		}
		api.registerService({
			id: PLUGIN_ID,
			async start(ctx) {
				try {
					const fixed = secureResolverPath(root);
					if (fixed.length)
						api.logger?.info?.(
							`Falcon Vault removed group/world write from ${fixed.join(', ')} so OpenClaw can run its resolver; run \`openclaw secrets reload\` if Vault references failed at startup`
						);
				} catch (error) {
					api.logger?.warn?.(
						`Falcon Vault could not check its resolver path: ${(error as Error).message}`
					);
				}
				// Feature plugins take no config in this SDK, so the locations are fixed (spec §3).
				try {
					await startVault(ctx.stateDir);
					ctx.serviceHealth?.clearFailure();
				} catch (error) {
					// The Vault tab says why; the Gateway's service health carries the same reason.
					ctx.serviceHealth?.reportFailure(error);
					api.logger?.warn?.(`Falcon Vault unavailable: ${(error as Error).message}`);
				}
			}
			// No stop: the Vault is shared with the registration that replaces this one.
		});

		/**
		 * OpenClaw's live config, for Usages (spec §5). `api.runtime.config.current()` is the runtime
		 * snapshot, in which resolved credentials stand where the SecretRefs were (checked on
		 * OpenClaw 2026.9.7), so Usages read the source snapshot that goes with it: the same live
		 * config, as written, with its SecretRefs. Neither is stored.
		 */
		const liveConfig = (): unknown => {
			try {
				return getRuntimeConfigSourceSnapshot() ?? api.runtime.config.current();
			} catch {
				return {};
			}
		};

		const changed = () => {
			try {
				events.emit('changed', { at: new Date().toISOString() });
			} catch (error) {
				api.logger?.warn?.(`Falcon Vault change notice failed: ${(error as Error).message}`);
			}
		};
		const committed = <T extends { outcome: string }>(r: T) => {
			if (r.outcome === 'committed') changed();
			return r;
		};

		/** Tell the agent that asked (spec §9): the entry is ready, never its value. */
		const tell = (request: Request | null, text: string) => {
			if (!request?.session || !request.actor.startsWith('agent:')) return;
			const agentId = request.actor.slice('agent:'.length);
			try {
				const queued = api.runtime.system.enqueueSystemEvent(text, {
					sessionKey: request.session,
					agentId
				});
				if (!queued) api.logger?.warn?.(`Falcon Vault could not tell ${request.actor}: not queued`);
			} catch (error) {
				api.logger?.warn?.(
					`Falcon Vault could not tell ${request.actor}: ${(error as Error).message}`
				);
			}
		};

		const providerAlias = () =>
			vaultProviders(liveConfig(), PLUGIN_ID)[0] ?? DEFAULT_PROVIDER_ALIAS;

		return {
			async agent(input, context) {
				const ops = await currentVault();
				const actor = actorFor(context);
				const i = input;
				const fields: EntryFields = {
					title: i.title,
					group: i.group,
					username: i.username,
					url: i.url,
					notes: i.notes
				};
				switch (i.action) {
					case 'list':
						return answer(() => ops.agentList({ group: i.group, search: i.search }));
					case 'get':
						if (!i.path) return invalid('get: give the entry path');
						return answer(() => ops.agentEntry(i.path!, liveConfig(), PLUGIN_ID));
					case 'store': {
						if (!i.title) return invalid('store: give a title');
						if (!i.password)
							return invalid('store: give the password (to ask the person instead, use request)');
						if (i.reason) return invalid('store: reason is for request');
						// The result names the path and Reference; the value is never echoed.
						const r = await ops.create(
							actor,
							{ ...fields, password: i.password },
							{
								key: keyFor(context),
								action: 'store'
							}
						);
						return committed(r);
					}
					case 'request': {
						if (!i.title) return invalid('request: give a title');
						if (i.password)
							return invalid('request: leave out the password; use store if you hold it');
						if (!i.reason) return invalid('request: say in one line why you need it (reason)');
						const session = context.source === 'tool' ? (context.tool.sessionKey ?? null) : null;
						const r = await ops.request(
							actor,
							{ ...fields, reason: i.reason, session },
							keyFor(context)
						);
						return committed(
							r.outcome === 'committed'
								? {
										...r,
										note: 'It waits under Needs a value in the Vault tab. You will be told here when it is filled.'
									}
								: r
						);
					}
				}
				return invalid('Unknown action');
			},

			async browse(input) {
				let ops: VaultOps;
				try {
					ops = await currentVault();
				} catch (error) {
					// Never an empty list: the tab shows why (spec §3).
					return {
						unavailable: (error as Error).message ?? lastFailure() ?? 'Falcon Vault is unavailable'
					};
				}
				switch (input.view) {
					case 'overview':
						return { ...(await ops.overview()), provider_alias: providerAlias() };
					case 'list':
						return answer(async () => ({
							entries: await ops.list({
								group: input.group,
								scope: input.scope,
								search: input.search
							})
						}));
					case 'entry':
						if (!input.path) return invalid('entry: give the path');
						return answer(() => ops.entry(input.path!, input.uuid, liveConfig(), PLUGIN_ID));
					case 'history':
						return {
							events: ops.history({
								path: input.path,
								actor: input.actor,
								action: input.action,
								before: input.before,
								limit: input.limit
							})
						};
				}
				return invalid('Unknown view');
			},

			async reveal(input, context) {
				const ops = await currentVault();
				return ops.reveal(
					actorFor(context),
					{ path: input.path, uuid: input.uuid },
					input.field,
					input.purpose
				);
			},

			async edit(input, context) {
				const ops = await currentVault();
				const actor = actorFor(context);
				const key = input.idempotency_key;
				const at = { path: input.path ?? '', uuid: input.uuid };
				const f = input.fields ?? {};
				const needPath = () => (input.path ? null : invalid(`${input.command}: give the path`));
				switch (input.command) {
					case 'create_entry':
						return committed(await ops.create(actor, f, { key }));
					case 'update_entry':
						return needPath() ?? committed(await ops.update(actor, at, f, key));
					case 'recycle_entry':
						return needPath() ?? committed(await ops.recycle(actor, at, key));
					case 'delete_forever':
						return needPath() ?? committed(await ops.deleteForever(actor, at, key));
					case 'fill_request': {
						if (needPath()) return needPath();
						const { result, request } = await ops.fill(actor, at, f.password ?? '', key);
						if (result.outcome === 'committed')
							tell(
								request,
								`Falcon Vault: the entry you requested, ${result.path}, now has a value.${result.reference ? ` Use it in config through its reference "${result.reference}".` : ''}`
							);
						return committed(result);
					}
					case 'dismiss_request': {
						if (needPath()) return needPath();
						const { result, request } = await ops.dismiss(actor, at, key);
						if (result.outcome === 'committed')
							tell(
								request,
								`Falcon Vault: your request for ${at.path} was dismissed; it will not be filled.`
							);
						return committed(result);
					}
					case 'create_group':
						if (!input.name) return invalid('create_group: give a name');
						return committed(await ops.createGroup(actor, input.parent ?? '', input.name, key));
					case 'rename_group':
						if (!input.name) return invalid('rename_group: give a name');
						return needPath() ?? committed(await ops.renameGroup(actor, at.path, input.name, key));
					case 'move_group':
						return (
							needPath() ?? committed(await ops.moveGroup(actor, at.path, input.parent ?? '', key))
						);
					case 'delete_group':
						return needPath() ?? committed(await ops.deleteGroup(actor, at.path, key));
				}
				return invalid('Unknown command');
			}
		};
	}
});

export default feature;
