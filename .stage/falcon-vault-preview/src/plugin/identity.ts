import { getPluginRuntimeGatewayRequestScope } from 'openclaw/plugin-sdk/plugin-runtime';

/** `person:<id>` for a signed-in person. */
type Actor = { kind: 'human'; id: string };

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
 * The person behind a Control UI request, from the Gateway's authenticated connection — never from
 * request parameters. Vault is shared per Gateway (spec §1), so a verified operator connection with no
 * named profile (a paired browser, or the gateway token) is the Gateway owner.
 */
export function humanFromClient(client: Client | undefined): Actor | null {
	if (!client || client.invalidated || client.internal?.syntheticClient) return null;
	if (client.connect?.role && client.connect.role !== 'operator') return null;
	const role = client.internal?.operatorRoleActor;
	if (role?.kind && role.kind !== 'operator') return null;
	const named = client.authenticatedUserProfile?.profileId;
	if (named && role?.profileId && role.profileId !== named) return null;
	return { kind: 'human', id: `person:${named ?? role?.profileId ?? 'gateway-owner'}` };
}

export const currentHuman = (): Actor | null =>
	humanFromClient(getPluginRuntimeGatewayRequestScope()?.client as Client | undefined);
