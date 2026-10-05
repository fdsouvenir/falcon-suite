import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { Check, Errors } from 'typebox/value';
import type { TSchema } from 'typebox';
import {
	InputRequired,
	Rejection,
	reject,
	type Actor,
	type Envelope,
	type Needed,
	type Outcome,
	type Warning
} from './types.js';

/** Tables that hold versioned objects, by object kind. */
export const TABLES = {
	objective: 'objective',
	kpi: 'kpi',
	area: 'area',
	project: 'project',
	milestone: 'milestone',
	task: 'task',
	question: 'question',
	decision: 'decision',
	finding: 'finding',
	ask: 'ask'
} as const;
export type Kind = keyof typeof TABLES;

type Row = Record<string, unknown>;

/** What a command implementation sees. Everything runs inside one IMMEDIATE transaction. */
export class Context {
	readonly warnings: Warning[] = [];
	result: { id: string; version: number | null; data?: unknown } | null = null;
	noop = false;

	constructor(
		readonly db: DatabaseSync,
		readonly actor: Actor,
		readonly now: string,
		readonly command: string,
		/** The Gateway owner: the default accountable person. */
		readonly owner: string
	) {}

	newId(): string {
		return randomUUID();
	}
	all<T = Row>(sql: string, ...args: SQLInputValue[]): T[] {
		return this.db.prepare(sql).all(...args) as T[];
	}
	one<T = Row>(sql: string, ...args: SQLInputValue[]): T | undefined {
		return this.db.prepare(sql).get(...args) as T | undefined;
	}
	run(sql: string, ...args: SQLInputValue[]): void {
		this.db.prepare(sql).run(...args);
	}

	/** Load an object of a kind, or reject. */
	get<T = Row>(kind: Kind, id: unknown): T {
		if (typeof id !== 'string' || !id) reject('missing_id', `A ${kind} id is required`);
		const row = this.one<T>(`SELECT * FROM ${TABLES[kind]} WHERE id = ?`, id as string);
		if (!row) reject('not_found', `No ${kind} ${id as string}`);
		return row as T;
	}

	/** Insert a row from a plain object. JSON-encodes arrays and objects. */
	insert(table: string, values: Row): void {
		const keys = Object.keys(values);
		this.run(
			`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
			...keys.map((k) => encode(values[k]))
		);
	}

	/** Update fields on a versioned object and bump its version. Returns the new version. */
	update(kind: Kind, id: string, fields: Row): number {
		const keys = Object.keys(fields);
		const sets = [...keys.map((k) => `${k} = ?`), 'version = version + 1'];
		this.run(
			`UPDATE ${TABLES[kind]} SET ${sets.join(', ')} WHERE id = ?`,
			...keys.map((k) => encode(fields[k])),
			id
		);
		return (
			this.one<{ version: number }>(`SELECT version FROM ${TABLES[kind]} WHERE id = ?`, id) as {
				version: number;
			}
		).version;
	}

	event(kind: string, id: string, version: number | null, detail?: unknown): void {
		this.insert('event', {
			at: this.now,
			actor: this.actor.id,
			command: this.command,
			object_kind: kind,
			object_id: id,
			version,
			detail: detail === undefined ? null : JSON.stringify(detail)
		});
	}

	link(
		kind: 'serves' | 'depends_on' | 'targets',
		sourceKind: string,
		sourceId: string,
		targetKind: string,
		targetId: string
	): void {
		this.run(
			'INSERT OR IGNORE INTO link (kind, source_kind, source_id, target_kind, target_id) VALUES (?,?,?,?,?)',
			kind,
			sourceKind,
			sourceId,
			targetKind,
			targetId
		);
	}

	warn(code: string, message: string, ref?: string): void {
		this.warnings.push({ code, message, ...(ref ? { ref } : {}) });
	}

	/** Create an Ask addressed to someone, inheriting the subject's discussion session. */
	ask(
		subjectKind: string,
		subjectId: string,
		addressedTo: string,
		prompt: string,
		session: string | null
	): string {
		const id = this.newId();
		this.insert('ask', {
			id,
			subject_kind: subjectKind,
			subject_id: subjectId,
			addressed_to: addressedTo,
			prompt,
			status: 'pending',
			session_key: session,
			session_set_by: session ? this.actor.id : null,
			created_at: this.now,
			version: 1
		});
		this.event('ask', id, 1, { subject: subjectId, to: addressedTo });
		return id;
	}

	/** Resolve every pending Ask about a subject. */
	resolveAsks(subjectId: string, status: 'answered' | 'dismissed' = 'answered'): void {
		for (const a of this.all<{ id: string }>(
			"SELECT id FROM ask WHERE subject_id = ? AND status = 'pending'",
			subjectId
		))
			this.event('ask', a.id, this.update('ask', a.id, { status, resolved_at: this.now }));
	}

	done(id: string, version: number | null, data?: unknown): void {
		this.result = { id, version, data };
	}
	nothing(id: string, version: number | null): void {
		this.noop = true;
		this.result = { id, version };
	}
}

export type CommandDef = {
	name: string;
	/** Object kind the command acts on; when set, `id` is required and `expected_version` is checked. */
	on?: Kind;
	humanOnly?: boolean;
	summary: string;
	input: TSchema;
	run(ctx: Context, input: any, target: Row | null): void;
};

export const defineCommand = (def: CommandDef): CommandDef => def;

const encode = (v: unknown): SQLInputValue =>
	v === undefined || v === null
		? null
		: Array.isArray(v) || (typeof v === 'object' && !(v instanceof Uint8Array))
			? JSON.stringify(v)
			: (v as SQLInputValue);

/** Execute one command envelope atomically, with idempotency and optimistic versions. */
export function execute(
	db: DatabaseSync,
	commands: Map<string, CommandDef>,
	envelope: Envelope,
	actor: Actor,
	owner: string,
	now: string = new Date().toISOString()
): Outcome {
	const def = commands.get(envelope.command);
	if (!def)
		return rejected('unknown_command', `Unknown command ${envelope.command}`, ['read help']);
	if (def.humanOnly && actor.kind !== 'human')
		return rejected('human_only', `${def.name} can only be done by a person`, ['raise_decision']);
	const input = envelope.input ?? {};
	if (!Check(def.input, input)) {
		const first = [...Errors(def.input, input)][0];
		// Say exactly what the command takes, so an agent that guessed a field name fixes it in one go.
		const props =
			(def.input as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
		const required = new Set((def.input as { required?: string[] }).required ?? []);
		const fields = Object.keys(props).map((k) => (required.has(k) ? k : `${k}?`));
		const unknown = Object.keys(input).filter((k) => !(k in props));
		return rejected(
			'invalid_input',
			`${def.name}: ${unknown.length ? `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; ` : ''}${first ? `${first.instancePath || 'input'} ${first.message}` : 'invalid input'}. Fields: ${fields.join(', ') || 'none'}`,
			[`falcon_work_read view=help command=${def.name}`]
		);
	}

	const key = envelope.idempotency_key;
	const request = createHash('sha256')
		.update(
			JSON.stringify({
				c: envelope.command,
				i: envelope.id ?? null,
				v: envelope.expected_version ?? null,
				input
			})
		)
		.digest('hex');
	if (key) {
		const prior = db
			.prepare('SELECT actor, request, outcome FROM receipt WHERE key = ?')
			.get(key) as { actor: string; request: string; outcome: string } | undefined;
		if (prior) {
			if (prior.actor !== actor.id || prior.request !== request)
				return rejected(
					'idempotency_conflict',
					'This idempotency key was already used for a different request'
				);
			return JSON.parse(prior.outcome) as Outcome;
		}
	}

	const ctx = new Context(db, actor, now, def.name, owner);
	let outcome: Outcome;
	db.exec('BEGIN IMMEDIATE');
	try {
		let target: Row | null = null;
		if (def.on) {
			const loaded = ctx.get(def.on, envelope.id);
			target = loaded;
			if (envelope.expected_version !== undefined && loaded.version !== envelope.expected_version)
				throw new Rejection(
					'stale_version',
					`${def.on} changed since version ${envelope.expected_version}`,
					[`read get ${envelope.id}`],
					target
				);
		}
		def.run(ctx, input, target);
		const r = ctx.result ?? { id: envelope.id ?? '', version: null };
		outcome = ctx.noop
			? { outcome: 'noop', id: r.id, version: r.version }
			: {
					outcome: ctx.warnings.length ? 'committed_with_warnings' : 'committed',
					id: r.id,
					version: r.version,
					warnings: ctx.warnings,
					...(r.data === undefined ? {} : { data: r.data })
				};
		if (key)
			ctx.insert('receipt', {
				key,
				actor: actor.id,
				request,
				outcome: JSON.stringify(outcome),
				at: now
			});
		db.exec('COMMIT');
		return outcome;
	} catch (error) {
		if (error instanceof InputRequired) {
			// Asks already written stand; nothing else in the command was applied.
			outcome = { outcome: 'input_required', id: error.subject, needed: error.needed };
			if (key)
				ctx.insert('receipt', {
					key,
					actor: actor.id,
					request,
					outcome: JSON.stringify(outcome),
					at: now
				});
			db.exec('COMMIT');
			return outcome;
		}
		db.exec('ROLLBACK');
		if (error instanceof Rejection)
			return rejected(error.code, error.message, error.next, error.current);
		throw error;
	}
}

const rejected = (
	code: string,
	reason: string,
	next: string[] = [],
	current?: unknown
): Outcome => ({
	outcome: 'rejected',
	code,
	reason,
	next,
	...(current === undefined ? {} : { current })
});

export type { Needed };
