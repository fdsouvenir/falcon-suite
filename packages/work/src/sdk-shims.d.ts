// The pinned SDK ships this runtime entry without type declarations; Work types what it uses.
declare module 'openclaw/plugin-sdk/session-transcript-runtime' {
	export function readVisibleSessionTranscriptMessageEntries(params: {
		agentId: string;
		sessionKey: string;
		sessionId?: string;
	}): Promise<unknown>;
	export function createSessionCatalogSourceActorProjector(params: {
		pluginId: string;
		sourceDomain: string;
		actors: unknown[];
	}): (actor: unknown) => { label?: string } | undefined;
}
