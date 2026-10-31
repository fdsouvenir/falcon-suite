// Shared types for the Work store. Vocabulary: docs/work-spec.md §2.

/** Who is acting. `id` is `person:<profile>` for humans and `agent:<agentId>` for agents. */
export type Actor = { kind: 'human' | 'agent'; id: string };

export type Warning = { code: string; message: string; ref?: string };

export type Needed = { from: string; what: string; ask?: string };

export type Outcome =
	| {
			outcome: 'committed' | 'committed_with_warnings';
			id: string;
			version: number | null;
			warnings: Warning[];
			data?: unknown;
	  }
	| { outcome: 'noop'; id: string; version: number | null }
	| { outcome: 'input_required'; id: string | null; needed: Needed[] }
	| { outcome: 'rejected'; code: string; reason: string; next: string[]; current?: unknown };

export type Envelope = {
	command: string;
	id?: string;
	expected_version?: number;
	idempotency_key?: string;
	input?: Record<string, unknown>;
};

export type Source = { kind?: string; ref: string; label?: string };

/** Thrown inside a command to reject it; the transaction is rolled back. */
export class Rejection extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly next: string[] = [],
		readonly current?: unknown
	) {
		super(message);
	}
}

/** Thrown inside a command when someone else's input is needed. Asks created before it persist. */
export class InputRequired extends Error {
	constructor(
		readonly needed: Needed[],
		readonly subject: string | null = null
	) {
		super('input required');
	}
}

export const reject = (code: string, message: string, next: string[] = []): never => {
	throw new Rejection(code, message, next);
};
