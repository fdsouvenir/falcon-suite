import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openWorkDatabase } from './db.js';
import { execute, type CommandDef } from './engine.js';
import { Views } from './views.js';
import { jobCommands } from './commands/jobs.js';
import { projectCommands } from './commands/projects.js';
import { taskCommands } from './commands/tasks.js';
import { knowledgeCommands } from './commands/knowledge.js';
import { recordCommands } from './commands/record.js';
import type { Actor, Envelope, Outcome } from './types.js';

export const COMMANDS: CommandDef[] = [
	...jobCommands,
	...projectCommands,
	...taskCommands,
	...recordCommands,
	...knowledgeCommands
];

/** What a turn left outside the chat (spec §3.2). */
export type TurnOutcome = {
	kind: 'commit' | 'push' | 'pr' | 'release' | 'deploy' | 'message' | 'file' | 'config' | 'change';
	label: string;
	ref?: string;
};

export type ItemKind = 'task' | 'project' | 'job';

/** The Work store: commands (`do`), views, and the record the clerk keeps (spec §3, §4). */
export class Work {
	readonly db: DatabaseSync;
	readonly views: Views;
	private readonly commands = new Map(COMMANDS.map((c) => [c.name, c]));

	constructor(
		file: string,
		/** The Gateway owner, e.g. `person:<profile>`: who "Needs you" is for. */
		readonly owner: string,
		private readonly clock: () => string = () => new Date().toISOString()
	) {
		this.db = openWorkDatabase(file);
		this.views = new Views(this.db, owner, () => this.clock());
	}

	do(envelope: Envelope, actor: Actor): Outcome {
		if (
			!actor ||
			!['human', 'agent', 'work'].includes(actor.kind) ||
			!/^(person|agent|work):\S+$/.test(actor.id)
		)
			throw new TypeError('A valid actor is required');
		return execute(this.db, this.commands, envelope, actor, this.owner, this.clock());
	}

	/** One line per command, for the tool description. */
	catalog(): string[] {
		return COMMANDS.map((c) => `${c.name}${c.humanOnly ? ' (people only)' : ''}: ${c.summary}`);
	}

	help(command: string) {
		const c = this.commands.get(command);
		return c
			? {
					command: c.name,
					on: c.on ?? null,
					people_only: !!c.humanOnly,
					summary: c.summary,
					input: c.input
				}
			: null;
	}

	/** The kind of an item id, or null. */
	kindOf(id: string): ItemKind | null {
		for (const k of ['task', 'project', 'job'] as const)
			if (this.db.prepare(`SELECT 1 FROM ${k} WHERE id = ?`).get(id)) return k;
		return null;
	}

	/** Record that an item's work happened in a session (spec §4, item_session). */
	linkSession(item: string, kind: ItemKind, session: string, at: string = this.clock()): void {
		this.db
			.prepare(
				'INSERT INTO item_session (item_id, item_kind, session_key, first_seen_at, last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT (item_id, session_key) DO UPDATE SET last_seen_at = max(last_seen_at, excluded.last_seen_at)'
			)
			.run(item, kind, session, at, at);
		// A Task's work also happened in its Project's or Job's session.
		if (kind === 'task') {
			const t = this.db.prepare('SELECT project_id, job_id FROM task WHERE id = ?').get(item) as
				{ project_id: string | null; job_id: string | null } | undefined;
			if (t?.project_id) this.linkSession(t.project_id, 'project', session, at);
			if (t?.job_id) this.linkSession(t.job_id, 'job', session, at);
		}
	}

	/** One line of history (spec §3.3): what happened, under the item it concerns, or unfiled. */
	recordEntry(e: {
		agent: string;
		item?: { id: string; kind: ItemKind } | null;
		session?: string | null;
		run?: string | null;
		outcomes: TurnOutcome[];
		summary?: string | null;
		by: 'work' | 'agent' | 'person';
		at?: string;
	}): string | null {
		const id = randomUUID();
		const r = this.db
			.prepare(
				'INSERT INTO timeline_entry (id, subject_kind, subject_id, agent, session_key, run_id, at, outcomes, summary, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (run_id, subject_id) DO NOTHING'
			)
			.run(
				id,
				e.item?.kind ?? null,
				e.item?.id ?? null,
				e.agent,
				e.session ?? null,
				e.run ?? null,
				e.at ?? this.clock(),
				JSON.stringify(e.outcomes.slice(0, 50)),
				e.summary ? e.summary.slice(0, 2000) : null,
				e.by
			);
		if (e.item && e.session) this.linkSession(e.item.id, e.item.kind, e.session, e.at);
		return r.changes ? id : null;
	}

	/** Open items linked to a session, most recently active first (the clerk's candidates). */
	sessionItems(session: string, limit = 8) {
		return this.db
			.prepare(
				`SELECT s.item_id AS id, s.item_kind AS kind FROM item_session s
				 LEFT JOIN task t ON s.item_kind = 'task' AND t.id = s.item_id
				 LEFT JOIN project p ON s.item_kind = 'project' AND p.id = s.item_id
				 LEFT JOIN job j ON s.item_kind = 'job' AND j.id = s.item_id
				 WHERE s.session_key = ?
				   AND ((s.item_kind = 'task' AND t.status IN ('open','ready','in_progress','waiting'))
				     OR (s.item_kind = 'project' AND p.abandoned_at IS NULL)
				     OR (s.item_kind = 'job' AND j.status <> 'retired'))
				 ORDER BY s.last_seen_at DESC LIMIT ?`
			)
			.all(session, limit) as { id: string; kind: ItemKind }[];
	}

	/** The Job an automation runs, if any. */
	jobForAutomation(automation: string): string | null {
		return (
			(
				this.db
					.prepare('SELECT job_id FROM job_automation WHERE automation_id = ?')
					.get(automation) as { job_id: string } | undefined
			)?.job_id ?? null
		);
	}

	meta(key: string): string | null {
		return (
			(
				this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
					{ value: string } | undefined
			)?.value ?? null
		);
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare(
				'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
			)
			.run(key, value);
	}

	now(): string {
		return this.clock();
	}

	close(): void {
		this.db.close();
	}
}
