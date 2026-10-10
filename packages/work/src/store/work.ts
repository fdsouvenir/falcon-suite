import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openWorkDatabase } from './db.js';
import { execute, type CommandDef } from './engine.js';
import { Reads, DEFAULT_THRESHOLDS, type Thresholds } from './reads.js';
import { Views } from './views.js';
import { objectiveCommands } from './commands/objectives.js';
import { structureCommands } from './commands/structure.js';
import { taskCommands } from './commands/tasks.js';
import { knowledgeCommands } from './commands/knowledge.js';
import type { Actor, Envelope, Outcome } from './types.js';

export const COMMANDS: CommandDef[] = [
	...objectiveCommands,
	...structureCommands,
	...taskCommands,
	...knowledgeCommands
];

/** What a turn left outside the chat (spec §10, The record keeper). */
export type TurnOutcome = {
	kind: 'commit' | 'push' | 'pr' | 'release' | 'deploy' | 'message' | 'file' | 'config' | 'change';
	label: string;
	ref?: string;
};

/** The Work store: commands (`do`), reads, and the writes the hooks make (spec §10). */
export class Work {
	readonly db: DatabaseSync;
	readonly reads: Reads;
	readonly views: Views;
	private readonly commands = new Map(COMMANDS.map((c) => [c.name, c]));

	constructor(
		file: string,
		/** The Gateway owner, e.g. `person:<profile>`: the default accountable person. */
		readonly owner: string,
		thresholds: Thresholds = DEFAULT_THRESHOLDS,
		private readonly clock: () => string = () => new Date().toISOString()
	) {
		this.db = openWorkDatabase(file);
		this.reads = new Reads(this.db, thresholds);
		this.views = new Views(this.db, this.reads);
	}

	do(envelope: Envelope, actor: Actor): Outcome {
		if (
			!actor ||
			(actor.kind !== 'human' && actor.kind !== 'agent') ||
			!/^(person|agent):\S+$/.test(actor.id)
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

	/** The session a subagent was spawned from, recorded by the subagent_spawned hook. */
	setParent(session: string, parent: string): void {
		if (session === parent) return;
		this.db
			.prepare(
				'INSERT INTO session_parent (session_key, parent_key) VALUES (?, ?) ON CONFLICT (session_key) DO UPDATE SET parent_key = excluded.parent_key'
			)
			.run(session, parent);
	}

	/**
	 * The Task a session is working on: its own, or else its parent's (a subagent works under the
	 * Task it was spawned for). Only an unfinished Task counts.
	 */
	sessionTask(session: string | null | undefined): string | null {
		const seen = new Set<string>();
		for (let key = session ?? null; key && !seen.has(key);) {
			seen.add(key);
			const row = this.db
				.prepare(
					"SELECT s.task_id AS id FROM session_task s JOIN task t ON t.id = s.task_id WHERE s.session_key = ? AND t.status IN ('open','ready','in_progress','waiting')"
				)
				.get(key) as { id: string } | undefined;
			if (row) return row.id;
			key =
				(
					this.db
						.prepare('SELECT parent_key FROM session_parent WHERE session_key = ?')
						.get(key) as { parent_key: string } | undefined
				)?.parent_key ?? null;
		}
		return null;
	}

	/** Make a Task the session's current Task (the agent started it here, or Work filed work under it). */
	setSessionTask(session: string, task: string): void {
		this.db
			.prepare(
				'INSERT INTO session_task (session_key, task_id, set_at) VALUES (?, ?, ?) ON CONFLICT (session_key) DO UPDATE SET task_id = excluded.task_id, set_at = excluded.set_at'
			)
			.run(session, task, this.clock());
	}

	/** One turn on the timeline: its outcomes and summary, under a Task or unfiled. */
	recordTurn(e: {
		agent: string;
		session?: string | null;
		run?: string | null;
		task?: string | null;
		outcomes: TurnOutcome[];
		summary?: string | null;
		by: 'work' | 'agent';
	}): string {
		const id = randomUUID();
		this.db
			.prepare(
				'INSERT INTO timeline_entry (id, task_id, agent, session_key, run_id, at, outcomes, summary, recorded_by) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (run_id) DO NOTHING'
			)
			.run(
				id,
				e.task ?? null,
				e.agent,
				e.session ?? null,
				e.run ?? null,
				this.clock(),
				JSON.stringify(e.outcomes.slice(0, 50)),
				e.summary ? e.summary.slice(0, 2000) : null,
				e.by
			);
		return id;
	}

	/** Mark something the record keeper wrote, so the person can tell it apart. */
	markRecordedByWork(id: string): void {
		this.db
			.prepare('INSERT OR IGNORE INTO work_recorded (object_id, at) VALUES (?, ?)')
			.run(id, this.clock());
	}

	now(): string {
		return this.clock();
	}

	close(): void {
		this.db.close();
	}
}
