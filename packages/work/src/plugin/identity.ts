import { getPluginRuntimeGatewayRequestScope } from 'openclaw/plugin-sdk/plugin-runtime';
import type { Actor } from '../store/types.js';

type Client = {
	invalidated?: boolean;
	connect?: { role?: string };
	internal?: {
		syntheticClient?: boolean;
		operatorRoleActor?: { kind?: string; profileId?: string };
	};
	authenticatedUserId?: string;
	authenticatedUserProfile?: { profileId?: string };
};

/**
 * The person behind the current Control UI request, from the Gateway's authenticated connection.
 * Never taken from request parameters. Null when the caller is not a verified human operator.
 */
export function currentHuman(): Actor | null {
	const client = getPluginRuntimeGatewayRequestScope()?.client as Client | undefined;
	if (!client || client.invalidated || client.internal?.syntheticClient) return null;
	if (client.connect?.role && client.connect.role !== 'operator') return null;
	const role = client.internal?.operatorRoleActor;
	if (role?.kind === 'system') return null;
	const profile =
		client.authenticatedUserProfile?.profileId ??
		(role?.kind === 'operator' ? role.profileId : undefined);
	if (!profile) return null;
	if (role?.kind === 'operator' && role.profileId && role.profileId !== profile) return null;
	return { kind: 'human', id: `person:${profile}` };
}
