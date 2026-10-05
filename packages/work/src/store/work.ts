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

const ACTIVITY_KINDS = [
	'command',
	'file',
	'message',
	'commit',
	'release',
	'config',
	'api',
	'session'
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

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

	/**
	 * Record what an agent actually did (from after_tool_call). It is attached to the agent's
	 * in-progress Task — the one discussed in this session if there is one, else the most recently
	 * touched — or kept as untracked activity.
	 */
	recordActivity(a: {
		agent: string;
		session?: string | null;
		kind: ActivityKind;
		summary: string;
		ref?: string | null;
	}): { id: string; task: string | null } {
		const inProgress = this.db
			.prepare(
				"SELECT id, session_key FROM task WHERE agent = ? AND status = 'in_progress' ORDER BY updated_at DESC"
			)
			.all(a.agent) as { id: string; session_key: string | null }[];
		const task =
			(a.session && inProgress.find((t) => t.session_key === a.session)) || inProgress[0];
		const id = randomUUID();
		this.db
			.prepare(
				'INSERT INTO activity (id, task_id, agent, session_key, at, kind, summary, ref) VALUES (?,?,?,?,?,?,?,?)'
			)
			.run(
				id,
				task?.id ?? null,
				a.agent,
				a.session ?? null,
				this.clock(),
				a.kind,
				a.summary.slice(0, 1000),
				a.ref ?? null
			);
		return { id, task: task?.id ?? null };
	}

	now(): string {
		return this.clock();
	}

	close(): void {
		this.db.close();
	}
}
