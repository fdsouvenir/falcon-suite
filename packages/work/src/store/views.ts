import type { DatabaseSync } from 'node:sqlite';

/**
 * What the pages show (spec §6): Home, Project, Task, Job and search. Read-only projections; every
 * shape here is what the Control UI renders.
 */

type Ref = { id: string; kind: 'task' | 'project' | 'job'; title: string };
export type SessionRef = { key: string; last_seen_at: string };
export type NeedsYouItem = {
	kind: 'question' | 'decision';
	id: string;
	prompt: string;
	about: Ref | null;
	session: string | null;
	since: string;
	options?: { id: string; label: string }[];
	recommendation?: string | null;
};
export type Card = {
	id: string;
	kind: 'task' | 'project' | 'job';
	title: string;
	status_line: string | null;
	column: 'moving' | 'waiting';
	waiting: string | null;
	agent: string | null;
	sessions: number;
	last_activity: string;
	tasks?: { done: number; total: number; open: number };
	milestone?: { position: number; of: number; title: string } | null;
	done_this_week?: number;
};
export type DoneRow = Ref & { at: string };
export type Entry = {
	id: string;
	at: string;
	summary: string | null;
	agent: string;
	by: string;
	session: string | null;
	outcomes: { kind: string; label: string; ref?: string }[];
	item: Ref | null;
};

const OPEN = "('open','ready','in_progress','waiting')";
const WEEK = 7 * 864e5;
const json = <T>(v: unknown, fallback: T): T => {
	try {
		return v ? (JSON.parse(v as string) as T) : fallback;
	} catch {
		return fallback;
	}
};

export class Views {
	constructor(
		private readonly db: DatabaseSync,
		private readonly owner: string,
		private readonly now: () => string
	) {}

	private all<T>(sql: string, ...a: (string | number | null)[]): T[] {
		return this.db.prepare(sql).all(...a) as T[];
	}
	private one<T>(sql: string, ...a: (string | number | null)[]): T | undefined {
		return this.db.prepare(sql).get(...a) as T | undefined;
	}

	ref(id: string | null | undefined): Ref | null {
		if (!id) return null;
		const t = this.one<{ title: string }>(
			'SELECT d.title FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev WHERE t.id = ?',
			id
		);
		if (t) return { id, kind: 'task', title: t.title };
		const p = this.one<{ title: string }>('SELECT title FROM project WHERE id = ?', id);
		if (p) return { id, kind: 'project', title: p.title };
		const j = this.one<{ title: string }>('SELECT title FROM job WHERE id = ?', id);
		if (j) return { id, kind: 'job', title: j.title };
		return null;
	}

	/** The item a Question or Decision is about: a Task's Project or Job counts as the item. */
	private aboutOf(id: string): Ref | null {
		const t = this.one<{ target_kind: string; target_id: string }>(
			"SELECT target_kind, target_id FROM link WHERE kind = 'targets' AND source_id = ? ORDER BY target_kind = 'milestone' LIMIT 1",
			id
		);
		if (!t) return null;
		if (t.target_kind === 'milestone') {
			const m = this.one<{ project_id: string }>(
				'SELECT project_id FROM milestone WHERE id = ?',
				t.target_id
			);
			return this.ref(m?.project_id);
		}
		return this.ref(t.target_id);
	}

	/** Open Questions and pending Decisions for the person, oldest first. */
	needsYou(person: string = this.owner): NeedsYouItem[] {
		const qs = this.all<{
			id: string;
			prompt: string;
			session_key: string | null;
			created_at: string;
			answerable_by: string;
		}>(
			"SELECT id, prompt, session_key, created_at, answerable_by FROM question WHERE status = 'open' ORDER BY created_at"
		)
			.filter((q) => json<string[]>(q.answerable_by, []).includes(person))
			.map<NeedsYouItem>((q) => ({
				kind: 'question',
				id: q.id,
				prompt: q.prompt,
				about: this.aboutOf(q.id),
				session: q.session_key,
				since: q.created_at
			}));
		const ds = this.all<{
			id: string;
			prompt: string;
			session_key: string | null;
			created_at: string;
			deciders: string;
			options: string;
			recommendation: string;
			status: string;
			deferred_until: string | null;
		}>("SELECT * FROM decision WHERE status IN ('pending','deferred') ORDER BY created_at")
			.filter((d) => json<string[]>(d.deciders, []).includes(person))
			.filter((d) => d.status === 'pending' || !d.deferred_until || d.deferred_until <= this.now())
			.map<NeedsYouItem>((d) => ({
				kind: 'decision',
				id: d.id,
				prompt: d.prompt,
				about: this.aboutOf(d.id),
				session: d.session_key,
				since: d.created_at,
				options: json<{ id: string; label: string }[]>(d.options, []).map((o) => ({
					id: o.id,
					label: o.label
				})),
				recommendation: json<{ option?: string }>(d.recommendation, {}).option ?? null
			}));
		return [...qs, ...ds].sort((a, b) => a.since.localeCompare(b.since));
	}

	private sessions(id: string): SessionRef[] {
		return this.all<SessionRef>(
			'SELECT session_key AS key, last_seen_at FROM item_session WHERE item_id = ? ORDER BY last_seen_at DESC',
			id
		);
	}

	private lastActivity(id: string, fallback: string): string {
		const r = this.one<{ at: string | null }>(
			'SELECT max(at) AS at FROM timeline_entry WHERE subject_id = ? OR subject_id IN (SELECT id FROM task WHERE project_id = ? OR job_id = ?)',
			id,
			id,
			id
		);
		// When the work happened, as the history shows it: a record written later (catch-up) does
		// not make old work look new. Only an item with no history falls back to its own time.
		return r?.at ?? fallback;
	}

	private waitingText(t: {
		waiting_for: string | null;
		waiting_on_kind: string | null;
		waiting_on_ref: string | null;
		follow_up_at: string | null;
	}): string {
		const on =
			t.waiting_on_kind === 'person'
				? t.waiting_on_ref === this.owner
					? 'you'
					: t.waiting_on_ref
				: t.waiting_on_ref;
		return `Waiting on ${on ?? 'something'}${t.waiting_for ? `: ${t.waiting_for}` : ''}`;
	}

	/** The board (spec §6, Home): Jobs and Projects are one card each; only standalone Tasks get their own. */
	board(person: string = this.owner): { moving: Card[]; waiting: Card[]; done: DoneRow[] } {
		const now = this.now();
		const weekAgo = new Date(Date.parse(now) - WEEK).toISOString();
		const needs = new Set(
			this.needsYou(person)
				.map((n) => n.about?.id)
				.filter(Boolean) as string[]
		);
		const cards: Card[] = [];
		// Jobs.
		for (const j of this.all<{
			id: string;
			title: string;
			status: string;
			agent: string | null;
			status_line: string | null;
			updated_at: string;
		}>(
			"SELECT id, title, status, agent, status_line, updated_at FROM job WHERE status <> 'retired'"
		)) {
			const counts = this.one<{ open: number; done_week: number }>(
				`SELECT sum(status IN ${OPEN}) AS open, sum(status = 'completed' AND updated_at >= ?) AS done_week FROM task WHERE job_id = ?`,
				weekAgo,
				j.id
			)!;
			const waitingAll = this.one<{ n: number; w: number }>(
				`SELECT count(*) AS n, sum(status = 'waiting') AS w FROM task WHERE job_id = ? AND status IN ${OPEN}`,
				j.id
			)!;
			cards.push({
				id: j.id,
				kind: 'job',
				title: j.title,
				status_line: j.status_line,
				column:
					j.status === 'paused' || (waitingAll.n > 0 && waitingAll.w === waitingAll.n)
						? 'waiting'
						: 'moving',
				waiting: j.status === 'paused' ? 'Paused' : null,
				agent: j.agent,
				sessions: this.sessions(j.id).length,
				last_activity: this.lastActivity(j.id, j.updated_at),
				tasks: { done: 0, total: 0, open: counts.open ?? 0 },
				done_this_week: counts.done_week ?? 0
			});
		}
		// Projects that are not finished.
		for (const p of this.all<{
			id: string;
			title: string;
			agent: string | null;
			status_line: string | null;
			updated_at: string;
		}>(
			'SELECT id, title, agent, status_line, updated_at FROM project WHERE abandoned_at IS NULL'
		)) {
			const c = this.one<{ total: number; done: number; open: number; waiting: number }>(
				`SELECT count(*) AS total, sum(status = 'completed') AS done, sum(status IN ${OPEN}) AS open, sum(status = 'waiting') AS waiting
				 FROM task WHERE project_id = ? AND status <> 'abandoned'`,
				p.id
			)!;
			const ms = this.all<{ title: string; position: number; status: string }>(
				'SELECT title, position, status FROM milestone WHERE project_id = ? ORDER BY position',
				p.id
			);
			const finished =
				(c.total > 0 && c.open === 0 && ms.every((m) => m.status === 'achieved')) ||
				(ms.length > 0 && ms.every((m) => m.status === 'achieved') && (c.open ?? 0) === 0);
			if (finished) continue;
			const cur = ms.find((m) => m.status === 'open');
			const waitingTask =
				(c.open ?? 0) > 0 && c.waiting === c.open
					? this.one<{
							waiting_for: string | null;
							waiting_on_kind: string | null;
							waiting_on_ref: string | null;
							follow_up_at: string | null;
						}>(
							"SELECT waiting_for, waiting_on_kind, waiting_on_ref, follow_up_at FROM task WHERE project_id = ? AND status = 'waiting' ORDER BY updated_at DESC LIMIT 1",
							p.id
						)
					: undefined;
			cards.push({
				id: p.id,
				kind: 'project',
				title: p.title,
				status_line: p.status_line,
				column: waitingTask ? 'waiting' : 'moving',
				waiting: waitingTask ? this.waitingText(waitingTask) : null,
				agent: p.agent,
				sessions: this.sessions(p.id).length,
				last_activity: this.lastActivity(p.id, p.updated_at),
				tasks: { done: c.done ?? 0, total: c.total ?? 0, open: c.open ?? 0 },
				milestone: cur ? { position: cur.position, of: ms.length, title: cur.title } : null
			});
		}
		// Standalone Tasks.
		for (const t of this.all<{
			id: string;
			title: string;
			status: string;
			agent: string | null;
			status_line: string | null;
			updated_at: string;
			waiting_for: string | null;
			waiting_on_kind: string | null;
			waiting_on_ref: string | null;
			follow_up_at: string | null;
		}>(
			`SELECT t.id, d.title, t.status, t.agent, t.status_line, t.updated_at, t.waiting_for, t.waiting_on_kind, t.waiting_on_ref, t.follow_up_at
			 FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev
			 WHERE t.project_id IS NULL AND t.job_id IS NULL AND t.status IN ${OPEN}`
		))
			cards.push({
				id: t.id,
				kind: 'task',
				title: t.title,
				status_line: t.status_line,
				column: t.status === 'waiting' ? 'waiting' : 'moving',
				waiting: t.status === 'waiting' ? this.waitingText(t) : null,
				agent: t.agent,
				sessions: this.sessions(t.id).length,
				last_activity: this.lastActivity(t.id, t.updated_at)
			});
		const shown = cards
			.filter((c) => !needs.has(c.id))
			.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
		const done: DoneRow[] = [
			...this.all<{ id: string; title: string; at: string }>(
				`SELECT t.id, d.title, t.updated_at AS at FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev
				 WHERE t.status = 'completed' AND t.project_id IS NULL AND t.job_id IS NULL AND t.updated_at >= ?`,
				weekAgo
			)
				.map((r) => ({ ...r, at: this.lastActivity(r.id, r.at), kind: 'task' as const }))
				.filter((r) => r.at >= weekAgo),
			...this.all<{ id: string; title: string; at: string }>(
				`SELECT p.id, p.title, max(coalesce(m.achieved_at, p.updated_at)) AS at FROM project p LEFT JOIN milestone m ON m.project_id = p.id
				 WHERE p.abandoned_at IS NULL AND NOT EXISTS (SELECT 1 FROM task t WHERE t.project_id = p.id AND t.status IN ${OPEN})
				   AND EXISTS (SELECT 1 FROM milestone m2 WHERE m2.project_id = p.id)
				   AND NOT EXISTS (SELECT 1 FROM milestone m3 WHERE m3.project_id = p.id AND m3.status = 'open')
				 GROUP BY p.id HAVING at >= ?`,
				weekAgo
			).map((r) => ({ ...r, kind: 'project' as const }))
		].sort((a, b) => b.at.localeCompare(a.at));
		return {
			moving: shown.filter((c) => c.column === 'moving'),
			waiting: shown.filter((c) => c.column === 'waiting'),
			done
		};
	}

	private entries(where: string, args: (string | number | null)[], limit: number): Entry[] {
		return this.all<{
			id: string;
			at: string;
			summary: string | null;
			agent: string;
			recorded_by: string;
			session_key: string | null;
			outcomes: string;
			subject_id: string | null;
		}>(`SELECT * FROM timeline_entry ${where} ORDER BY at DESC LIMIT ?`, ...args, limit).map(
			(e) => ({
				id: e.id,
				at: e.at,
				summary: e.summary,
				agent: e.agent,
				by: e.recorded_by,
				session: e.session_key,
				outcomes: json(e.outcomes, []),
				item: this.ref(e.subject_id)
			})
		);
	}

	/** What happened since a moment (spec §6, Home): entries with a sentence, newest first. */
	happened(since: string | null, limit = 30): Entry[] {
		return since
			? this.entries('WHERE summary IS NOT NULL AND at > ?', [since], limit)
			: this.entries('WHERE summary IS NOT NULL', [], limit);
	}

	home(person: string = this.owner, since: string | null = null) {
		const catchup = this.one<{ value: string }>("SELECT value FROM meta WHERE key = 'catchup'");
		return {
			owner: person,
			since,
			catching_up: catchup
				? json<{ read: number; total: number; done: boolean }>(catchup.value, {
						read: 0,
						total: 0,
						done: true
					})
				: null,
			needs_you: this.needsYou(person),
			board: this.board(person),
			happened: this.happened(since)
		};
	}

	private questionsAbout(ids: string[], person: string) {
		const set = new Set(ids);
		return this.needsYou(person).filter((n) => {
			const targets = this.all<{ target_id: string }>(
				"SELECT target_id FROM link WHERE kind = 'targets' AND source_id = ?",
				n.id
			);
			return targets.some((t) => set.has(t.target_id)) || (n.about && set.has(n.about.id));
		});
	}

	private findings(ids: string[]) {
		if (!ids.length) return [];
		return this.all<{ id: string; conclusion: string; confidence: string; created_at: string }>(
			`SELECT DISTINCT f.id, f.conclusion, f.confidence, f.created_at FROM finding f JOIN link l ON l.kind = 'targets' AND l.source_id = f.id
			 WHERE f.status = 'current' AND l.target_id IN (${ids.map(() => '?').join(',')}) ORDER BY f.created_at DESC`,
			...ids
		);
	}

	private taskRow(id: string) {
		return this.one<{
			id: string;
			title: string;
			description: string;
			done_when: string;
			status: string;
			agent: string | null;
			status_line: string | null;
			project_id: string | null;
			milestone_id: string | null;
			job_id: string | null;
			waiting_for: string | null;
			waiting_on_kind: string | null;
			waiting_on_ref: string | null;
			follow_up_at: string | null;
			created_at: string;
			updated_at: string;
			accepted_result_id: string | null;
			definition_rev: number;
		}>(
			`SELECT t.*, d.title, d.description, d.done_when FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev WHERE t.id = ?`,
			id
		);
	}

	private taskLine(id: string) {
		const t = this.taskRow(id)!;
		return {
			id,
			title: t.title,
			status: t.status,
			status_line: t.status_line,
			waiting: t.status === 'waiting' ? this.waitingText(t) : null,
			sessions: this.sessions(id),
			updated_at: t.updated_at
		};
	}

	task(id: string, person: string = this.owner) {
		const t = this.taskRow(id);
		if (!t) return null;
		const plan = this.one<{ content: string; at: string }>(
			'SELECT content, at FROM task_plan WHERE task_id = ? ORDER BY rev DESC LIMIT 1',
			id
		);
		const result = t.accepted_result_id
			? this.one<{ content: string; sources: string; at: string }>(
					'SELECT content, sources, at FROM task_result WHERE id = ?',
					t.accepted_result_id
				)
			: undefined;
		return {
			kind: 'task' as const,
			id,
			title: t.title,
			description: t.description,
			done_when: t.done_when,
			status: t.status,
			status_line: t.status_line,
			waiting: t.status === 'waiting' ? this.waitingText(t) : null,
			agent: t.agent,
			created_at: t.created_at,
			last_activity: this.lastActivity(id, t.updated_at),
			belongs_to: this.ref(t.project_id ?? t.job_id),
			milestone: t.milestone_id
				? (this.one<{ title: string; position: number }>(
						'SELECT title, position FROM milestone WHERE id = ?',
						t.milestone_id
					) ?? null)
				: null,
			plan: plan ?? null,
			result: result
				? { content: result.content, sources: json(result.sources, []), at: result.at }
				: null,
			needs_you: this.questionsAbout([id], person),
			sessions: this.sessions(id),
			findings: this.findings([id]),
			happened: this.entries('WHERE subject_id = ?', [id], 50)
		};
	}

	project(id: string, person: string = this.owner) {
		const p = this.one<{
			id: string;
			title: string;
			outcome: string;
			agent: string | null;
			status_line: string | null;
			abandoned_at: string | null;
			created_at: string;
			updated_at: string;
		}>('SELECT * FROM project WHERE id = ?', id);
		if (!p) return null;
		const tasks = this.all<{ id: string; milestone_id: string | null }>(
			"SELECT id, milestone_id FROM task WHERE project_id = ? AND status <> 'abandoned' ORDER BY created_at",
			id
		);
		const ms = this.all<{
			id: string;
			title: string;
			success_condition: string;
			position: number;
			status: string;
			achieved_at: string | null;
			basis: string | null;
		}>(
			'SELECT id, title, success_condition, position, status, achieved_at, basis FROM milestone WHERE project_id = ? ORDER BY position',
			id
		);
		const current = ms.find((m) => m.status === 'open')?.id ?? null;
		const done = this.one<{ n: number }>(
			"SELECT count(*) AS n FROM task WHERE project_id = ? AND status = 'completed'",
			id
		)!.n;
		return {
			kind: 'project' as const,
			id,
			title: p.title,
			outcome: p.outcome,
			status_line: p.status_line,
			agent: p.agent,
			abandoned: !!p.abandoned_at,
			created_at: p.created_at,
			last_activity: this.lastActivity(id, p.updated_at),
			tasks_done: done,
			tasks_total: tasks.length,
			milestones: ms.map((m) => ({
				...m,
				state: m.status === 'achieved' ? 'achieved' : m.id === current ? 'current' : 'upcoming',
				tasks: tasks.filter((t) => t.milestone_id === m.id).map((t) => this.taskLine(t.id))
			})),
			other_tasks: tasks.filter((t) => !t.milestone_id).map((t) => this.taskLine(t.id)),
			needs_you: this.questionsAbout(
				[id, ...tasks.map((t) => t.id), ...ms.map((m) => m.id)],
				person
			),
			sessions: this.sessions(id),
			findings: this.findings([id, ...tasks.map((t) => t.id)]),
			happened: this.entries(
				`WHERE summary IS NOT NULL AND (subject_id = ? OR subject_id IN (SELECT id FROM task WHERE project_id = ?))`,
				[id, id],
				50
			)
		};
	}

	job(id: string, person: string = this.owner) {
		const j = this.one<{
			id: string;
			title: string;
			instructions: string;
			status: string;
			agent: string | null;
			status_line: string | null;
			created_at: string;
			updated_at: string;
		}>('SELECT * FROM job WHERE id = ?', id);
		if (!j) return null;
		const weekAgo = new Date(Date.parse(this.now()) - WEEK).toISOString();
		const open = this.all<{ id: string }>(
			`SELECT id FROM task WHERE job_id = ? AND status IN ${OPEN} ORDER BY updated_at DESC`,
			id
		);
		const doneWeek = this.all<{ id: string }>(
			"SELECT id FROM task WHERE job_id = ? AND status = 'completed' AND updated_at >= ? ORDER BY updated_at DESC",
			id,
			weekAgo
		);
		return {
			kind: 'job' as const,
			id,
			title: j.title,
			instructions: j.instructions,
			status: j.status,
			status_line: j.status_line,
			agent: j.agent,
			created_at: j.created_at,
			last_activity: this.lastActivity(id, j.updated_at),
			automations: this.all<{ automation_id: string; name: string | null }>(
				'SELECT automation_id, name FROM job_automation WHERE job_id = ? ORDER BY name',
				id
			),
			open_tasks: open.map((t) => this.taskLine(t.id)),
			done_this_week: doneWeek.map((t) => this.taskLine(t.id)),
			needs_you: this.questionsAbout([id, ...open.map((t) => t.id)], person),
			sessions: this.sessions(id),
			happened: this.entries(
				`WHERE summary IS NOT NULL AND (subject_id = ? OR subject_id IN (SELECT id FROM task WHERE job_id = ?))`,
				[id, id],
				50
			)
		};
	}

	/** Find Jobs, Projects and Tasks by words in their title or status line. */
	search(q: string, limit = 30): (Ref & { status_line: string | null; state: string })[] {
		const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
		return [
			...this.all<{ id: string; title: string; status_line: string | null; state: string }>(
				"SELECT id, title, status_line, status AS state FROM job WHERE title LIKE ? ESCAPE '\\' OR status_line LIKE ? ESCAPE '\\'",
				like,
				like
			).map((r) => ({ ...r, kind: 'job' as const })),
			...this.all<{ id: string; title: string; status_line: string | null; state: string }>(
				"SELECT id, title, status_line, CASE WHEN abandoned_at IS NULL THEN 'open' ELSE 'abandoned' END AS state FROM project WHERE title LIKE ? ESCAPE '\\' OR outcome LIKE ? ESCAPE '\\' OR status_line LIKE ? ESCAPE '\\'",
				like,
				like,
				like
			).map((r) => ({ ...r, kind: 'project' as const })),
			...this.all<{ id: string; title: string; status_line: string | null; state: string }>(
				"SELECT t.id, d.title, t.status_line, t.status AS state FROM task t JOIN task_definition d ON d.task_id = t.id AND d.rev = t.definition_rev WHERE d.title LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR t.status_line LIKE ? ESCAPE '\\'",
				like,
				like,
				like
			).map((r) => ({ ...r, kind: 'task' as const }))
		].slice(0, limit);
	}

	/** Compact facts about one object for agents (falcon_work_read get). */
	get(id: string) {
		const kind = this.ref(id)?.kind;
		if (kind === 'task') return this.task(id);
		if (kind === 'project') return this.project(id);
		if (kind === 'job') return this.job(id);
		for (const t of ['question', 'decision', 'finding', 'milestone'] as const) {
			const r = this.one<Record<string, unknown>>(`SELECT * FROM ${t} WHERE id = ?`, id);
			if (r) return { kind: t, ...r };
		}
		return null;
	}
}
