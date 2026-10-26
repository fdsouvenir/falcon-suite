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
import { updateStatus } from './install.js';
import { PERMISSIONS, BASE_SCOPES } from './model.js';

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
		// Factual account data only. No system instructions, authority grants, or workspace writes.
		// Private Office inventory includes both human and agent accounts.
		api.on('before_prompt_build', async (_event, ctx) => {
			try {
				if (
					!link ||
					!ctx.agentId ||
					!ctx.sessionKey ||
					!/^agent:[^:]+:(?:main$|dashboard:)/.test(ctx.sessionKey)
				)
					return;
				await link.discover();
				return { prependContext: accountBrief(link.accounts(), link.discoveryUnavailable) };
			} catch {
				return;
			}
		});
		return {
			async status() {
				const l = ready();
				return {
					...(await overview(l.dir)),
					permissions: PERMISSIONS,
					baseline_scopes: BASE_SCOPES
				};
			},
			async accounts(input, context) {
				const l = ready();
				// Account facts are Office-local inventory, not an agent access-control list. On public
				// channel routes, do not automatically enumerate other people's account identities.
				if (
					context.source === 'tool' &&
					!/^agent:[^:]+:(?:main$|dashboard:)/.test(context.tool.sessionKey ?? '')
				)
					throw new Error('Account inventory is available in private Office sessions only.');
				await l.discover();
				return input.account_id ? l.invocation(input.account_id) : { accounts: l.accounts() };
			},
			start(input, context) {
				return ready().start(input, person(context));
			},
			login(input, context) {
				return ready().login(input.id, person(context));
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
			},
			updates(input, context) {
				person(context);
				return updateStatus(input.provider);
			}
		};
	}
});
