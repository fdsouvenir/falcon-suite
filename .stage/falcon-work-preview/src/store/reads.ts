import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TABLES, type Kind } from './engine.js';

type Row = Record<string, any>;
const HOUR = 36e5;
const UNFINISHED = "('open','ready','in_progress','waiting')";

/** Warning thresholds (spec §11). */
export type Thresholds = {
	stalledHours: number;
	unansweredDays: number;
	objectiveDays: number;
};
export const DEFAULT_THRESHOLDS: Thresholds = {
	stalledHours: 48,
	unansweredDays: 7,
	objectiveDays: 7
};

export type WarningItem = {
	kind: string;
	object: { kind: string; id: string };
	title: string;
	detail: string;
	since: string;
};

const JSON_COLUMNS = new Set([
	'sources',
	'options',
	'recommendation',
	'deciders',
	'answerable_by',
	'detail'
]);
const decode = (row: Row | undefined): Row | undefined => {
	if (!row) return row;
	for (const k of Object.keys(row))
		if (JSON_COLUMNS.has(k) && typeof row[k] === 'string') row[k] = JSON.parse(row[k]);
	return row;
};

export class Reads {
	constructor(
		private readonly db: DatabaseSync,
		private readonly thresholds: Thresholds = DEFAULT_THRESHOLDS
	) {}

	private all(sql: string, ...a: SQLInputValue[]): Row[] {
		return (this.db.prepare(sql).all(...a) as Row[]).map((r) => decode(r)!);
	}
	private one(sql: string, ...a: SQLInputValue[]): Row | undefined {
		return decode(this.db.prepare(sql).get(...a) as Row | undefined);
	}

	taskTitle(id: string): string {
		return (
			this.one(
				'SELECT d.title FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev WHERE t.id = ?',
				id
			)?.title ?? id
		);
	}

	/** Objectives a Task serves, directly or through its Project. */
	servedBy(taskId: string): string[] {
		return this.all(
			`SELECT target_id AS id FROM link WHERE kind = 'serves' AND source_id = ?
			 UNION SELECT l.target_id FROM task t JOIN link l ON l.kind = 'serves' AND l.source_id = t.project_id WHERE t.id = ?`,
			taskId,
			taskId
		).map((r) => r.id);
	}

	lastProgress(objectiveId: string): string | null {
		let last: string | null = null;
		for (const t of this.all("SELECT id, updated_at FROM task WHERE status = 'completed'"))
			if (this.servedBy(t.id).includes(objectiveId) && (!last || t.updated_at > last))
				last = t.updated_at;
		return last;
	}

	/** Derived blocked causes for a Task (spec §6). */
	blockedBy(taskId: string): string[] {
		const why: string[] = [];
		for (const d of this.all(
			`SELECT t.id FROM link l JOIN task t ON t.id = l.target_id WHERE l.kind = 'depends_on' AND l.source_id = ? AND t.status NOT IN ('completed','abandoned')`,
			taskId
		))
			why.push(`depends on "${this.taskTitle(d.id)}"`);
		for (const q of this.all(
			`SELECT q.prompt FROM link l JOIN question q ON q.id = l.source_id WHERE l.kind = 'targets' AND l.target_id = ? AND q.status = 'open'`,
			taskId
		))
			why.push(`open Question: ${q.prompt}`);
		for (const d of this.all(
			`SELECT d.prompt FROM link l JOIN decision d ON d.id = l.source_id WHERE l.kind = 'targets' AND l.target_id = ? AND d.status IN ('pending','deferred')`,
			taskId
		))
			why.push(`pending Decision: ${d.prompt}`);
		const t = this.one('SELECT status, waiting_for FROM task WHERE id = ?', taskId);
		if (t?.status === 'waiting') why.push(`waiting: ${t.waiting_for}`);
		return why;
	}

	projectStatus(p: Row): 'open' | 'completed' | 'abandoned' {
		if (p.abandoned_at) return 'abandoned';
		const ms = this.all('SELECT status FROM milestone WHERE project_id = ?', p.id);
		return ms.length > 0 && ms.every((m) => m.status === 'achieved') ? 'completed' : 'open';
	}

	objectives(includeInactive = false) {
		return this.all(
			`SELECT * FROM objective ${includeInactive ? '' : "WHERE status = 'active'"} ORDER BY rank IS NULL, rank, created_at`
		).map((o) => ({
			id: o.id,
			rank: o.rank,
			title: o.title,
			status: o.status,
			autonomy: o.autonomy,
			last_progress: this.lastProgress(o.id),
			kpis: this.all('SELECT * FROM kpi WHERE objective_id = ? AND removed_at IS NULL', o.id).map(
				(k) => ({
					id: k.id,
					name: k.name,
					unit: k.unit,
					direction: k.direction,
					target: k.target,
					latest:
						this.one(
							'SELECT value, at FROM kpi_reading WHERE kpi_id = ? ORDER BY at DESC LIMIT 1',
							k.id
						) ?? null
				})
			),
			latest_review:
				this.one(
					'SELECT at, moved, stalled, proposed FROM review WHERE objective_id = ? ORDER BY at DESC LIMIT 1',
					o.id
				) ?? null,
			serving: {
				projects: this.all(
					"SELECT p.id, p.title FROM link l JOIN project p ON p.id = l.source_id WHERE l.kind = 'serves' AND l.target_id = ?",
					o.id
				).map((p) => ({ id: p.id, title: p.title })),
				tasks: this.all(
					"SELECT t.id, t.status FROM link l JOIN task t ON t.id = l.source_id WHERE l.kind = 'serves' AND l.target_id = ?",
					o.id
				).map((t) => ({ id: t.id, title: this.taskTitle(t.id), status: t.status }))
			}
		}));
	}

	/** Questions, Decisions and Asks addressed to a person, and Warnings (spec §12, Needs you). */
	needsYou(person: string, now: string) {
		const asks = this.all(
			"SELECT * FROM ask WHERE addressed_to = ? AND status = 'pending' ORDER BY created_at",
			person
		);
		return {
			asks: asks.map((a) => ({
				id: a.id,
				subject: { kind: a.subject_kind, id: a.subject_id },
				prompt: a.prompt,
				session: a.session_key,
				since: a.created_at
			})),
			warnings: this.warnings(now)
		};
	}

	warnings(now: string): WarningItem[] {
		const t = this.thresholds;
		const age = (at: string) => (Date.parse(now) - Date.parse(at)) / HOUR;
		const out: WarningItem[] = [];
		for (const task of this.all("SELECT * FROM task WHERE status = 'in_progress'")) {
			const last =
				this.one('SELECT max(at) AS at FROM timeline_entry WHERE task_id = ?', task.id)?.at ??
				task.updated_at;
			if (age(last) > t.stalledHours)
				out.push({
					kind: 'stalled_task',
					object: { kind: 'task', id: task.id },
					title: this.taskTitle(task.id),
					detail: `Nothing on its timeline since ${last}`,
					since: last
				});
		}
		for (const task of this.all(
			"SELECT * FROM task WHERE status = 'waiting' AND follow_up_at IS NOT NULL"
		))
			if (age(task.follow_up_at) > 0)
				out.push({
					kind: 'follow_up_overdue',
					object: { kind: 'task', id: task.id },
					title: this.taskTitle(task.id),
					detail: `Follow-up was due ${task.follow_up_at}`,
					since: task.follow_up_at
				});
		for (const q of this.all("SELECT id, prompt, created_at FROM question WHERE status = 'open'"))
			if (age(q.created_at) > t.unansweredDays * 24)
				out.push({
					kind: 'unanswered',
					object: { kind: 'question', id: q.id },
					title: q.prompt,
					detail: `Open since ${q.created_at}`,
					since: q.created_at
				});
		for (const d of this.all(
			"SELECT id, prompt, created_at FROM decision WHERE status = 'pending'"
		))
			if (age(d.created_at) > t.unansweredDays * 24)
				out.push({
					kind: 'unanswered',
					object: { kind: 'decision', id: d.id },
					title: d.prompt,
					detail: `Open since ${d.created_at}`,
					since: d.created_at
				});
		for (const o of this.all("SELECT * FROM objective WHERE status = 'active'")) {
			const since = this.lastProgress(o.id) ?? o.created_at;
			if (age(since) > t.objectiveDays * 24)
				out.push({
					kind: 'objective_without_progress',
					object: { kind: 'objective', id: o.id },
					title: o.title,
					detail: this.lastProgress(o.id)
						? `Last progress ${since}`
						: `No progress since it was set on ${since}`,
					since
				});
		}
		const unfiled = this.all('SELECT at FROM timeline_entry WHERE task_id IS NULL ORDER BY at');
		if (unfiled.length)
			out.push({
				kind: 'unfiled_work',
				object: { kind: 'timeline', id: '' },
				title: 'Unfiled work',
				detail: `${unfiled.length} turn(s) of work not filed under a Task`,
				since: unfiled[0].at
			});
		for (const m of this.all(
			"SELECT m.*, p.title AS project_title FROM milestone m JOIN project p ON p.id = m.project_id WHERE m.status = 'open' AND p.abandoned_at IS NULL"
		)) {
			const ts = this.all('SELECT status FROM task WHERE milestone_id = ?', m.id);
			if (ts.length && ts.every((x) => x.status === 'completed' || x.status === 'abandoned'))
				out.push({
					kind: 'milestone_ready',
					object: { kind: 'milestone', id: m.id },
					title: `${m.project_title}: ${m.title}`,
					detail: 'Every Task is finished but the Milestone is not achieved',
					since: now
				});
		}
		return out.sort((a, b) => a.since.localeCompare(b.since));
	}

	/** The short per-turn brief for an agent (spec §10). */
	brief(agent: string, since: string | null, now: string) {
		const tasks = (status: string) =>
			this.all(
				`SELECT * FROM task WHERE agent = ? AND status = ? ORDER BY updated_at DESC LIMIT 20`,
				agent,
				status
			).map((t) => ({
				id: t.id,
				title: this.taskTitle(t.id),
				...(status === 'waiting'
					? { waiting_for: t.waiting_for, follow_up_at: t.follow_up_at }
					: {}),
				blocked_by: this.blockedBy(t.id)
			}));
		const resolved = since
			? [
					...this.all(
						`SELECT q.id, q.prompt, a.text, a.author FROM answer a JOIN question q ON q.id = a.question_id WHERE q.created_by = ? AND a.at > ? ORDER BY a.at`,
						agent,
						since
					).map((r) => ({
						kind: 'answer',
						id: r.id,
						prompt: r.prompt,
						answer: r.text,
						by: r.author
					})),
					...this.all(
						`SELECT id, prompt, chosen_option, decided_by, options FROM decision WHERE created_by = ? AND status = 'decided' AND resolved_at > ?`,
						agent,
						since
					).map((d) => ({
						kind: 'decision',
						id: d.id,
						prompt: d.prompt,
						chosen: (d.options as { id: string; label: string }[]).find(
							(o) => o.id === d.chosen_option
						)?.label,
						by: d.decided_by
					}))
				]
			: [];
		const mine = new Set(this.all('SELECT id FROM task WHERE agent = ?', agent).map((r) => r.id));
		const ranks = new Map(this.objectives().map((o) => [o.id, o.rank as number]));
		// Where work lives: active Areas and their open Projects, so plans go into the right place.
		const structure = this.all(
			"SELECT id, title FROM area WHERE status = 'active' ORDER BY title LIMIT 20"
		).map((a) => ({
			id: a.id,
			title: a.title,
			projects: this.all(
				'SELECT * FROM project WHERE area_id = ? AND abandoned_at IS NULL ORDER BY created_at LIMIT 15',
				a.id
			)
				.filter((p) => this.projectStatus(p) === 'open')
				.map((p) => {
					const ms = this.all(
						'SELECT title, position, status FROM milestone WHERE project_id = ? ORDER BY position',
						p.id
					);
					const current = ms.find((m) => m.status !== 'achieved');
					return {
						id: p.id,
						title: p.title,
						serves: this.all(
							"SELECT target_id FROM link WHERE kind = 'serves' AND source_kind = 'project' AND source_id = ?",
							p.id
						)
							.map((l) => ranks.get(l.target_id))
							.filter((r): r is number => typeof r === 'number'),
						milestone: current
							? { position: current.position, of: ms.length, title: current.title }
							: null,
						open_tasks: this.one(
							"SELECT count(*) AS n FROM task WHERE project_id = ? AND status IN ('open','ready','in_progress','waiting')",
							p.id
						)!.n as number
					};
				})
		}));
		return {
			objectives: this.objectives().map((o) => ({
				rank: o.rank,
				id: o.id,
				title: o.title,
				autonomy: o.autonomy,
				last_progress: o.last_progress
			})),
			structure,
			in_progress: tasks('in_progress'),
			waiting: tasks('waiting'),
			resolved_for_you: resolved,
			asks_for_you: this.all(
				"SELECT id, subject_id, prompt FROM ask WHERE addressed_to = ? AND status = 'pending'",
				agent
			),
			warnings: this.warnings(now).filter((w) => w.object.kind !== 'task' || mine.has(w.object.id))
		};
	}

	get(id: string) {
		for (const kind of Object.keys(TABLES) as Kind[]) {
			const row = this.one(`SELECT * FROM ${TABLES[kind]} WHERE id = ?`, id);
			if (!row) continue;
			const detail: Row = { kind, ...row };
			if (kind === 'task') {
				detail.definitions = this.all(
					'SELECT * FROM task_definition WHERE task_id = ? ORDER BY rev',
					id
				);
				detail.definition = detail.definitions.at(-1);
				detail.plans = this.all('SELECT * FROM task_plan WHERE task_id = ? ORDER BY rev', id);
				detail.results = this.all('SELECT * FROM task_result WHERE task_id = ? ORDER BY at', id);
				detail.timeline = this.timeline({ task: id, limit: 100 }).entries;
				detail.recorded_by_work = !!this.one('SELECT 1 FROM work_recorded WHERE object_id = ?', id);
				// Where the Task came from: the session of its first turn.
				detail.origin =
					this.one(
						'SELECT session_key AS session, at FROM timeline_entry WHERE task_id = ? ORDER BY at LIMIT 1',
						id
					) ?? null;
				detail.depends_on = this.all(
					"SELECT target_id AS id FROM link WHERE kind = 'depends_on' AND source_id = ?",
					id
				).map((r) => r.id);
				detail.needed_by = this.all(
					"SELECT source_id AS id FROM link WHERE kind = 'depends_on' AND target_id = ?",
					id
				).map((r) => r.id);
				detail.blocked_by = this.blockedBy(id);
				detail.serves = this.servedBy(id);
			}
			if (kind === 'project') {
				detail.status = this.projectStatus(row);
				detail.milestones = this.all(
					'SELECT * FROM milestone WHERE project_id = ? ORDER BY position',
					id
				).map((m) => ({
					...m,
					tasks: this.all('SELECT id, status, agent FROM task WHERE milestone_id = ?', m.id).map(
						(t) => ({ ...t, title: this.taskTitle(t.id) })
					)
				}));
				detail.tasks = this.all(
					'SELECT id, status, agent FROM task WHERE project_id = ? AND milestone_id IS NULL',
					id
				).map((t) => ({ ...t, title: this.taskTitle(t.id) }));
				detail.serves = this.all(
					"SELECT target_id AS id FROM link WHERE kind = 'serves' AND source_id = ?",
					id
				).map((r) => r.id);
			}
			if (kind === 'objective') {
				detail.kpis = this.all('SELECT * FROM kpi WHERE objective_id = ?', id).map((k) => ({
					...k,
					readings: this.all('SELECT * FROM kpi_reading WHERE kpi_id = ? ORDER BY at', k.id)
				}));
				detail.reviews = this.all(
					'SELECT * FROM review WHERE objective_id = ? ORDER BY at DESC',
					id
				);
				detail.last_progress = this.lastProgress(id);
			}
			if (kind === 'question')
				detail.answers = this.all('SELECT * FROM answer WHERE question_id = ? ORDER BY at', id);
			detail.about = this.all(
				`SELECT source_kind AS kind, source_id AS id FROM link WHERE kind = 'targets' AND target_id = ?`,
				id
			);
			detail.targets = this.all(
				`SELECT target_kind AS kind, target_id AS id FROM link WHERE kind = 'targets' AND source_id = ?`,
				id
			);
			detail.history = this.all(
				'SELECT seq, at, actor, command, version, detail FROM event WHERE object_id = ? ORDER BY seq DESC LIMIT 50',
				id
			);
			return detail;
		}
		return null;
	}

	list(
		kind: Kind,
		f: {
			area?: string;
			project?: string;
			objective?: string;
			status?: string;
			agent?: string;
			text?: string;
			limit?: number;
			offset?: number;
		} = {}
	) {
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (f.status && kind !== 'project') (where.push('x.status = ?'), args.push(f.status));
		if (f.agent && kind === 'task') (where.push('x.agent = ?'), args.push(f.agent));
		if (f.area && (kind === 'task' || kind === 'project'))
			kind === 'task'
				? (where.push(
						'(x.area_id = ? OR x.project_id IN (SELECT id FROM project WHERE area_id = ?))'
					),
					args.push(f.area, f.area))
				: (where.push('x.area_id = ?'), args.push(f.area));
		if (f.project && kind === 'task') (where.push('x.project_id = ?'), args.push(f.project));
		if (f.project && kind === 'milestone') (where.push('x.project_id = ?'), args.push(f.project));
		if (f.objective && (kind === 'task' || kind === 'project'))
			(where.push(`x.id IN (SELECT source_id FROM link WHERE kind = 'serves' AND target_id = ?)`),
				args.push(f.objective));
		const limit = Math.min(f.limit ?? 50, 200);
		const offset = f.offset ?? 0;
		let rows = this.all(
			`SELECT x.* FROM ${TABLES[kind]} x ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.rowid DESC`,
			...args
		);
		const title = (r: Row) =>
			kind === 'task'
				? this.taskTitle(r.id)
				: (r.title ?? r.prompt ?? r.conclusion ?? r.name ?? '');
		if (f.text) rows = rows.filter((r) => title(r).toLowerCase().includes(f.text!.toLowerCase()));
		if (kind === 'project' && f.status)
			rows = rows.filter((r) => this.projectStatus(r) === f.status);
		const page = rows.slice(offset, offset + limit).map((r) => ({
			id: r.id,
			title: title(r),
			status: kind === 'project' ? this.projectStatus(r) : r.status,
			...(kind === 'task'
				? { agent: r.agent, area: r.area_id, project: r.project_id, milestone: r.milestone_id }
				: {}),
			...(kind === 'project' ? { area: r.area_id } : {}),
			version: r.version
		}));
		return {
			total: rows.length,
			items: page,
			next_offset: offset + limit < rows.length ? offset + limit : null
		};
	}

	/**
	 * Timeline entries, newest first (spec §10, Timeline): a Task's, a session's, the unfiled ones,
	 * or everything. Outcomes are parsed; entries without outcomes are turns of discussion.
	 */
	timeline(
		f: {
			task?: string;
			session?: string;
			unfiled?: boolean;
			agent?: string;
			limit?: number;
			before?: string;
		} = {}
	) {
		const where: string[] = [];
		const args: string[] = [];
		if (f.task) (where.push('e.task_id = ?'), args.push(f.task));
		if (f.unfiled) where.push('e.task_id IS NULL');
		if (f.session) (where.push('e.session_key = ?'), args.push(f.session));
		if (f.agent) (where.push('e.agent = ?'), args.push(f.agent));
		if (f.before) (where.push('e.at < ?'), args.push(f.before));
		const limit = Math.min(f.limit ?? 50, 200);
		const rows = this.all(
			`SELECT e.*, d.title AS task_title, coalesce(p.title, a.title) AS place_title,
				(t.status = 'completed' AND e.at = (SELECT max(x.at) FROM timeline_entry x WHERE x.task_id = e.task_id)) AS completed_task
			 FROM timeline_entry e
			 LEFT JOIN task t ON t.id = e.task_id
			 LEFT JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev
			 LEFT JOIN project p ON p.id = t.project_id
			 LEFT JOIN area a ON a.id = t.area_id
			 ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.at DESC LIMIT ?`,
			...args,
			limit
		);
		return {
			entries: rows.map((r) => ({
				id: r.id,
				task: r.task_id ? { id: r.task_id, title: r.task_title, place: r.place_title } : null,
				/** This turn finished its Task (the Task's last entry, and the Task is completed). */
				completed: !!r.completed_task,
				agent: r.agent,
				session: r.session_key,
				run: r.run_id,
				at: r.at,
				outcomes: JSON.parse(r.outcomes),
				summary: r.summary,
				recorded_by: r.recorded_by
			})),
			next_before: rows.length === limit ? rows.at(-1)!.at : null
		};
	}
}
