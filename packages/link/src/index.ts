import {
	defineFeaturePlugin,
	type FeatureInvocationContext
} from 'openclaw/plugin-sdk/feature-plugin';
import { getPluginRuntimeGatewayRequestScope } from 'openclaw/plugin-sdk/plugin-runtime';
import path from 'node:path';
import { accountBrief } from './brief.js';
import { contract } from './contract.js';
import { overview } from './status.js';
import { LinkService } from './service.js';
import { PLUGIN_ID } from './identity.js';
import { BASE_SCOPES, type Provider } from './model.js';

// Account facts are omitted in group, channel and room conversations and provided elsewhere.
const shared = (sessionKey: string) =>
	/^agent:[^:]+:[^:]+:(?:group|channel|room):/.test(sessionKey);
function person(context: FeatureInvocationContext): string {
	if (context.source !== 'session-action')
		throw new Error('This operation requires the signed-in Link page.');
	const client = (getPluginRuntimeGatewayRequestScope()?.client ?? context.action.client) as any;
	if (!client || client.invalidated || client.internal?.syntheticClient)
		throw new Error('A signed-in operator is required.');
	return (
		client.authenticatedUserProfile?.profileId ??
		client.internal?.operatorRoleActor?.profileId ??
		'gateway-owner'
	);
}
export default defineFeaturePlugin({
	contract,
	name: 'Falcon Link',
	description: 'Connect and maintain known integrations.',
	setup(api) {
		let link: LinkService | undefined;
		const ready = () => {
			if (!link) throw new Error('Falcon Link is starting. Try again shortly.');
			return link;
		};
		api.registerService({
			id: PLUGIN_ID,
			start(ctx) {
				link = new LinkService(path.join(ctx.stateDir, PLUGIN_ID));
			},
			stop() {
				link?.stop();
				link = undefined;
			}
		});
		// Account facts for human and agent accounts, without credential values.
		api.on('before_prompt_build', async (_event, ctx) => {
			try {
				if (!link || !ctx.agentId || !ctx.sessionKey || shared(ctx.sessionKey)) return;
				await link.discover();
				return { prependContext: accountBrief(link.accounts(), link.discoveryUnavailable) };
			} catch {
				return;
			}
		});
		return {
			async status() {
				const l = ready();
				const [status, ...catalogs] = await Promise.all([
					overview(l.dir),
					...(['google', 'microsoft'] as Provider[]).map((p) => l.catalog(p).catch(() => null))
				]);
				return {
					...status,
					catalogs: { google: catalogs[0], microsoft: catalogs[1] },
					baseline_scopes: BASE_SCOPES
				};
			},
			async accounts(input, context) {
				const l = ready();
				if (
					context.source === 'tool' &&
					(!context.tool.sessionKey || shared(context.tool.sessionKey))
				)
					throw new Error('Account facts are not available in this conversation.');
				await l.discover();
				return input.account_id ? l.invocation(input.account_id) : { accounts: l.accounts() };
			},
			start(input, context) {
				return ready().start(input, person(context));
			},
			login(input, context) {
				return ready().poll(input.id, person(context));
			},
			finish(input, context) {
				return ready().finish(input.id, input.redirect, person(context));
			},
			cancel(input, context) {
				return ready().cancel(input.id, person(context));
			},
			check(input, context) {
				person(context);
				return ready().check(input.account_id);
			},
			disconnect(input, context) {
				person(context);
				return ready().disconnect(input.account_id);
			},
			metadata(input, context) {
				person(context);
				return ready().metadata(input.account_id, input.owner, input.purpose);
			},
			install(input, context) {
				person(context);
				return ready().install(input.provider);
			}
		};
	}
});
