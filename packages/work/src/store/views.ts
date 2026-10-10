import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Reads } from './reads.js';

// Screen projections for the native UI: each screen gets its data in one read.
// They compose Reads; nothing here writes.

type Row = Record<string, any>;
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

// OpenClaw refuses a reply over 4096 values or 256 KB; the feed keeps well under both.
const FEED_BUDGET = { values: 3500, bytes: 200_000 };
const CLIP = 1000;
const clip = (v: unknown): unknown =>
	typeof v === 'string'
		? v.length > CLIP
			? `${v.slice(0, CLIP)}…`
			: v
		: v && typeof v === 'object'
			? Array.isArray(v)
				? v.map(clip)
				: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
			: v;
const values = (v: unknown): number =>
	v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + values(x), 1) : 1;

export type SessionRef = { key: string; from: 'own' | 'project' | 'task' } | null;

export class Views {
	constructor(
		private readonly db: DatabaseSync,
		private readonly reads: Reads
	) {}

	private all(sql: string, ...a: SQLInputValue[]): Row[] {
		return this.db.prepare(sql).all(...a) as Row[];
	}
	private one(sql: string, ...a: SQLInputValue[]): Row | undefined {
		return this.db.prepare(sql).get(...a) as Row | undefined;
	}

	/** A Task's discussion session, falling back to its Project's (spec §9). */
	taskSession(taskId: string): SessionRef {
		const t = this.one('SELECT session_key, project_id FROM task WHERE id = ?', taskId);
		if (!t) return null;
		if (t.session_key) return { key: t.session_key, from: 'own' };
		const p =
			t.project_id && this.one('SELECT session_key FROM project WHERE id = ?', t.project_id);
		return p?.session_key ? { key: p.session_key, from: 'project' } : null;
	}

	/** Where a Task lives, for display. */
	place(t: Row): { kind: 'area' | 'project'; id: string; title: string } {
		if (t.project_id) {
			const p = this.one('SELECT title FROM project WHERE id = ?', t.project_id);
			return { kind: 'project', id: t.project_id, title: p?.title ?? '' };
		}
		const a = this.one('SELECT title FROM area WHERE id = ?', t.area_id);
		return { kind: 'area', id: t.area_id, title: a?.title ?? '' };
	}

	/** What to call any recorded object in a list. */
	private title(kind: string, id: string): string {
		if (kind === 'task') return this.reads.taskTitle(id);
		const table = [
			'objective',
			'area',
			'project',
			'milestone',
			'question',
			'decision',
			'finding',
			'ask',
			'kpi'
		].includes(kind)
			? kind
			: null;
		if (!table) return '';
		const r = this.one(`SELECT * FROM ${table} WHERE id = ?`, id);
		return (r?.title ?? r?.prompt ?? r?.conclusion ?? r?.name ?? '') as string;
	}

	taskCard(t: Row) {
		return {
			id: t.id,
			title: this.reads.taskTitle(t.id),
			status: t.status,
			agent: t.agent,
			place: this.place(t),
			session: this.taskSession(t.id),
			blocked_by: this.reads.blockedBy(t.id),
			waiting_for: t.waiting_for,
			waiting_on: t.waiting_on_kind ? { kind: t.waiting_on_kind, ref: t.waiting_on_ref } : null,
			resume_when: t.resume_when,
			follow_up_at: t.follow_up_at,
			updated_at: t.updated_at,
			version: t.version
		};
	}

	private askFor(subjectId: string, person: string) {
		return this.one(
			"SELECT id, session_key, version FROM ask WHERE subject_id = ? AND addressed_to = ? AND status = 'pending'",
			subjectId,
			person
		);
	}

	/** Session a Question or Decision is discussed in: its Ask's, else what it targets. */
	private knowledgeSession(id: string, person: string): SessionRef {
		const ask = this.askFor(id, person);
		if (ask?.session_key) return { key: ask.session_key, from: 'own' };
		for (const l of this.all(
			"SELECT target_kind, target_id FROM link WHERE kind = 'targets' AND source_id = ?",
			id
		)) {
			if (l.target_kind === 'task') {
				const s = this.taskSession(l.target_id);
				if (s) return { key: s.key, from: 'task' };
			}
			if (l.target_kind === 'project' || l.target_kind === 'objective') {
				const r = this.one(`SELECT session_key FROM ${l.target_kind} WHERE id = ?`, l.target_id);
				if (r?.session_key) return { key: r.session_key, from: 'project' };
			}
		}
		return null;
	}

	decisionCard(d: Row, person: string) {
		return {
			kind: 'decision' as const,
			id: d.id,
			prompt: d.prompt,
			options: parse(d.options),
			recommendation: parse(d.recommendation),
			consequence_of_no_decision: d.consequence_of_no_decision,
			status: d.status,
			created_at: d.created_at,
			created_by: d.created_by,
			can_decide: (parse(d.deciders) as string[]).includes(person),
			session: this.knowledgeSession(d.id, person),
			version: d.version
		};
	}

	questionCard(q: Row, person: string) {
		return {
			kind: 'question' as const,
			id: q.id,
			prompt: q.prompt,
			impact: q.impact,
			hypothesis: q.hypothesis,
			hypothesis_by: q.hypothesis_by,
			created_at: q.created_at,
			created_by: q.created_by,
			can_answer: (parse(q.answerable_by) as string[]).includes(person),
			holds: this.all(
				"SELECT count(*) AS n FROM link WHERE kind = 'targets' AND source_id = ? AND target_kind = 'task'",
				q.id
			)[0].n,
			session: this.knowledgeSession(q.id, person),
			version: q.version
		};
	}

	/**
	 * Everything on the Overview tab (spec §12). Needs you holds only what this person can act on,
	 * one entry per thing: Decisions to decide, Questions to answer, and Tasks waiting on them that
	 * no Decision or Question of theirs already covers. Happening now is the agents' work; Heads up
	 * is the remaining Warnings, those not already shown as the age of an item above.
	 */
	overview(person: string, now: string) {
		const decisions = this.all(
			"SELECT * FROM decision WHERE status IN ('pending','deferred') ORDER BY created_at"
		)
			.map((d) => this.decisionCard(d, person))
			.filter((d) => d.can_decide);
		const questions = this.all("SELECT * FROM question WHERE status = 'open' ORDER BY created_at")
			.map((q) => this.questionCard(q, person))
			.filter((q) => q.can_answer);
		// A Task held by one of this person's Decisions or Questions is covered by that item.
		const coveredBy = new Map<string, 'decision' | 'answer'>();
		for (const k of [...decisions, ...questions])
			for (const l of this.all(
				"SELECT target_id FROM link WHERE kind = 'targets' AND source_id = ? AND target_kind = 'task'",
				k.id
			))
				coveredBy.set(l.target_id, k.kind === 'decision' ? 'decision' : 'answer');
		const waitingOnYou = this.all(
			"SELECT * FROM task WHERE status = 'waiting' AND waiting_on_kind = 'person' AND waiting_on_ref = ? ORDER BY follow_up_at IS NULL, follow_up_at, updated_at",
			person
		).filter((t) => !coveredBy.has(t.id));
		const todo = [
			...waitingOnYou.map((t) => ({
				kind: 'task' as const,
				id: t.id,
				title: this.reads.taskTitle(t.id),
				agent: t.agent,
				waiting_for: t.waiting_for,
				resume_when: t.resume_when,
				follow_up_at: t.follow_up_at,
				since: t.updated_at
			}))
		];
		const todoIds = new Set(todo.map((t) => t.id));

		const card = (t: Row) => ({
			...this.taskCard(t),
			waiting_on_you: coveredBy.get(t.id) ?? null
		});
		const happening = [
			...this.all("SELECT * FROM task WHERE status = 'in_progress' ORDER BY updated_at DESC"),
			...this.all(
				"SELECT * FROM task WHERE status = 'waiting' ORDER BY follow_up_at IS NULL, follow_up_at"
			).filter((t) => !todoIds.has(t.id)),
			...this.all("SELECT * FROM task WHERE status = 'ready' ORDER BY updated_at DESC LIMIT 5")
		].map(card);

		const completed = this.all(
			"SELECT * FROM task WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 4"
		).map((t) => {
			const r = this.one(
				'SELECT content, sources, at FROM task_result WHERE id = ?',
				t.accepted_result_id
			);
			return {
				...this.taskCard(t),
				result: r ? { content: r.content, sources: parse(r.sources), at: r.at } : null
			};
		});
		const heads_up = this.reads
			.warnings(now)
			.filter(
				(w) =>
					w.kind !== 'unanswered' &&
					!(
						w.kind === 'follow_up_overdue' &&
						(todoIds.has(w.object.id) || coveredBy.has(w.object.id))
					)
			);
		const count = decisions.length + questions.length + todo.length;
		return {
			summary: {
				decide: decisions.length,
				answer: questions.length,
				todo: todo.length,
				in_progress: happening.filter((t) => t.status === 'in_progress').length
			},
			needs_you: { decisions, questions, todo, count },
			happening,
			heads_up,
			completed,
			unfiled: {
				count: this.one('SELECT count(*) AS n FROM timeline_entry WHERE task_id IS NULL')!.n
			},
			objectives: this.objectivesTab()
		};
	}

	/** The Objectives tab: ranked Objectives with KPIs, latest review and what serves them. */
	objectivesTab(includeInactive = false) {
		return this.reads.objectives(includeInactive).map((o) => ({
			...o,
			statement: this.one('SELECT statement FROM objective WHERE id = ?', o.id)?.statement,
			serving: {
				projects: o.serving.projects.map((p) => ({ ...p, ...this.taskCounts('project_id', p.id) })),
				tasks: o.serving.tasks
			}
		}));
	}

	private taskCounts(column: 'project_id' | 'milestone_id', id: string) {
		const r = this.one(
			`SELECT count(*) AS total, sum(status = 'completed') AS done FROM task WHERE ${column} = ? AND status <> 'abandoned'`,
			id
		)!;
		return { tasks_total: r.total as number, tasks_done: (r.done as number) ?? 0 };
	}

	private projectCard(p: Row, person: string) {
		const serves = this.all(
			"SELECT o.id, o.rank, o.title FROM link l JOIN objective o ON o.id = l.target_id WHERE l.kind = 'serves' AND l.source_id = ?",
			p.id
		);
		return {
			id: p.id,
			title: p.title,
			outcome: p.outcome,
			area: p.area_id,
			status: this.reads.projectStatus(p),
			accountable_human: p.accountable_human,
			serves,
			session: p.session_key ? { key: p.session_key, from: 'own' } : null,
			milestones: this.all(
				'SELECT * FROM milestone WHERE project_id = ? ORDER BY position',
				p.id
			).map((m) => ({
				id: m.id,
				position: m.position,
				title: m.title,
				success_condition: m.success_condition,
				status: m.status,
				achieved_at: m.achieved_at,
				basis: m.basis,
				sources: parse(m.sources),
				...this.taskCounts('milestone_id', m.id),
				tasks: this.all('SELECT * FROM task WHERE milestone_id = ? ORDER BY created_at', m.id).map(
					(t) => ({
						...this.taskCard(t),
						depends_on: this.all(
							"SELECT target_id FROM link WHERE kind = 'depends_on' AND source_id = ?",
							t.id
						).map((r) => ({ id: r.target_id, title: this.reads.taskTitle(r.target_id) }))
					})
				),
				decisions: this.all(
					"SELECT d.* FROM link l JOIN decision d ON d.id = l.source_id WHERE l.kind = 'targets' AND l.target_id = ? AND d.status = 'decided'",
					m.id
				).map((d) => this.decisionCard(d, person))
			})),
			tasks: this.all(
				'SELECT * FROM task WHERE project_id = ? AND milestone_id IS NULL ORDER BY created_at',
				p.id
			).map((t) => this.taskCard(t)),
			findings: this.all(
				"SELECT count(*) AS n FROM link l JOIN finding f ON f.id = l.source_id WHERE l.kind = 'targets' AND l.target_id = ? AND f.status = 'current'",
				p.id
			)[0].n,
			version: p.version
		};
	}

	/** Areas & Projects: the Area chips with counts, and Projects grouped by Area. */
	areas(person: string, area?: string) {
		const areas = this.all("SELECT * FROM area WHERE status = 'active' ORDER BY title").map((a) => {
			const projects = this.one(
				'SELECT count(*) AS n FROM project WHERE area_id = ? AND abandoned_at IS NULL',
				a.id
			)!.n;
			const tasks = this.one(
				"SELECT count(*) AS n FROM task t LEFT JOIN project p ON p.id = t.project_id WHERE (t.area_id = ? OR p.area_id = ?) AND t.status NOT IN ('completed','abandoned')",
				a.id,
				a.id
			)!.n;
			return {
				id: a.id,
				title: a.title,
				description: a.description,
				accountable_human: a.accountable_human,
				projects,
				open_tasks: tasks,
				version: a.version
			};
		});
		const shown = area ? areas.filter((a) => a.id === area) : areas;
		return {
			areas,
			groups: shown.map((a) => ({
				area: a,
				projects: this.all(
					'SELECT * FROM project WHERE area_id = ? ORDER BY abandoned_at IS NOT NULL, created_at',
					a.id
				).map((p) => this.projectCard(p, person)),
				tasks: this.all(
					"SELECT * FROM task WHERE area_id = ? AND status <> 'abandoned' ORDER BY status = 'completed', updated_at DESC",
					a.id
				).map((t) => this.taskCard(t))
			}))
		};
	}

	/** About-links: Questions, Decisions and Findings targeting any of these ids. */
	private about(ids: string[], person: string) {
		if (!ids.length) return [];
		const marks = ids.map(() => '?').join(',');
		const links = this.all(
			`SELECT DISTINCT source_kind, source_id FROM link WHERE kind = 'targets' AND target_id IN (${marks})`,
			...ids
		);
		return links
			.map((l) => {
				if (l.source_kind === 'decision') {
					const d = this.one('SELECT * FROM decision WHERE id = ?', l.source_id);
					return (
						d && {
							...this.decisionCard(d, person),
							chosen: d.chosen_option,
							decided_by: d.decided_by,
							resolved_at: d.resolved_at
						}
					);
				}
				if (l.source_kind === 'question') {
					const q = this.one('SELECT * FROM question WHERE id = ?', l.source_id);
					return q && { ...this.questionCard(q, person), status: q.status };
				}
				const f = this.one('SELECT * FROM finding WHERE id = ?', l.source_id);
				return (
					f && {
						kind: 'finding' as const,
						id: f.id,
						conclusion: f.conclusion,
						confidence: f.confidence,
						sources: parse(f.sources),
						status: f.status,
						created_at: f.created_at
					}
				);
			})
			.filter(Boolean);
	}

	project(id: string, person: string) {
		const p = this.one('SELECT * FROM project WHERE id = ?', id);
		if (!p) return null;
		const area = this.one('SELECT id, title FROM area WHERE id = ?', p.area_id);
		const taskIds = this.all('SELECT id FROM task WHERE project_id = ?', id).map((r) => r.id);
		const milestoneIds = this.all('SELECT id FROM milestone WHERE project_id = ?', id).map(
			(r) => r.id
		);
		return {
			...this.projectCard(p, person),
			area: area,
			about: this.about([id, ...taskIds, ...milestoneIds], person),
			history: this.all(
				`SELECT seq, at, actor, command, object_kind, object_id FROM event WHERE object_id IN (${[id, ...taskIds, ...milestoneIds].map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 20`,
				id,
				...taskIds,
				...milestoneIds
			).map((e) => ({
				...e,
				title: this.title(e.object_kind, e.object_id)
			}))
		};
	}

	objective(id: string, person: string) {
		const o = this.one('SELECT * FROM objective WHERE id = ?', id);
		if (!o) return null;
		const projects = this.all(
			"SELECT p.* FROM link l JOIN project p ON p.id = l.source_id WHERE l.kind = 'serves' AND l.target_id = ?",
			id
		).map((p) => ({
			...this.projectCard(p, person),
			area_title: this.one('SELECT title FROM area WHERE id = ?', p.area_id)?.title
		}));
		const tasks = this.all(
			"SELECT t.* FROM link l JOIN task t ON t.id = l.source_id WHERE l.kind = 'serves' AND l.target_id = ? AND t.project_id IS NULL",
			id
		).map((t) => this.taskCard(t));
		const related = [
			id,
			...projects.map((p) => p.id),
			...projects.flatMap((p) => p.milestones.flatMap((m) => m.tasks.map((t) => t.id))),
			...tasks.map((t) => t.id)
		];
		const about = this.about(related, person);
		return {
			id: o.id,
			rank: o.rank,
			title: o.title,
			statement: o.statement,
			status: o.status,
			autonomy: o.autonomy,
			limits: o.limits,
			owner: o.owner,
			session: o.session_key ? { key: o.session_key, from: 'own' } : null,
			last_progress: this.reads.lastProgress(id),
			created_at: o.created_at,
			kpis: this.all('SELECT * FROM kpi WHERE objective_id = ? AND removed_at IS NULL', id).map(
				(k) => ({
					...k,
					readings: this.all(
						'SELECT value, at, source FROM kpi_reading WHERE kpi_id = ? ORDER BY at',
						k.id
					)
				})
			),
			reviews: this.all('SELECT * FROM review WHERE objective_id = ? ORDER BY at DESC', id).map(
				(r) => ({ ...r, sources: parse(r.sources) })
			),
			serving: { projects, tasks },
			needs_you: about.filter(
				(x: any) =>
					(x.kind === 'decision' && x.status !== 'decided' && x.can_decide) ||
					(x.kind === 'question' && x.status === 'open' && x.can_answer)
			),
			warnings: this.reads.warnings(new Date().toISOString()).filter((w) => w.object.id === id),
			history: this.all(
				'SELECT seq, at, actor, command FROM event WHERE object_id = ? ORDER BY seq DESC LIMIT 20',
				id
			),
			version: o.version
		};
	}

	/**
	 * The Activity tab: every Task's timeline, newest first (spec §10, Timeline). Each entry is one
	 * turn: its outcomes, its summary, and the session it happened in.
	 */
	feed(f: { filter?: 'all' | 'unfiled'; agent?: string; limit?: number; before?: string }) {
		const t = this.reads.timeline({
			unfiled: f.filter === 'unfiled',
			agent: f.agent,
			limit: Math.min(f.limit ?? 100, 200),
			before: f.before
		});
		// Long text is clipped (the full record stays on the object); the newest entries that fit are kept.
		const kept: unknown[] = [];
		let used = { values: 4, bytes: 64 };
		for (const item of t.entries) {
			const c = clip(item as unknown as Row);
			const next = {
				values: used.values + values(c),
				bytes: used.bytes + Buffer.byteLength(JSON.stringify(c)) + 1
			};
			if (next.values > FEED_BUDGET.values || next.bytes > FEED_BUDGET.bytes) break;
			kept.push(c);
			used = next;
		}
		return {
			unfiled_count: this.one('SELECT count(*) AS n FROM timeline_entry WHERE task_id IS NULL')!.n,
			items: kept,
			next_before: kept.length < t.entries.length ? null : t.next_before,
			truncated: kept.length < t.entries.length
		};
	}

	/** Detail for the side panel: a Task, Question, Decision or Finding. */
	/** Targets with the titles a person reads. */
	private titled(targets: { kind: string; id: string }[] = []) {
		return targets.map((t) => ({
			...t,
			title:
				t.kind === 'task'
					? this.reads.taskTitle(t.id)
					: (this.one(`SELECT title FROM ${t.kind} WHERE id = ?`, t.id)?.title ?? t.id)
		}));
	}

	panel(id: string, person: string) {
		const d = this.reads.get(id);
		if (!d) return null;
		if (d.kind === 'task') {
			const t = this.one('SELECT * FROM task WHERE id = ?', id)!;
			const milestone = t.milestone_id
				? this.one('SELECT id, title, position FROM milestone WHERE id = ?', t.milestone_id)
				: null;
			return {
				...d,
				card: this.taskCard(t),
				milestone,
				needed_by: (d.needed_by as string[]).map((x) => ({
					id: x,
					title: this.reads.taskTitle(x)
				})),
				depends_on: (d.depends_on as string[]).map((x) => ({
					id: x,
					title: this.reads.taskTitle(x)
				})),
				accepted_result: d.results.find((r: Row) => r.id === t.accepted_result_id) ?? null,
				about: this.about([id], person)
			};
		}
		if (d.kind === 'decision')
			return {
				...d,
				card: this.decisionCard(this.one('SELECT * FROM decision WHERE id = ?', id)!, person),
				for: this.titled(d.targets)
			};
		if (d.kind === 'question')
			return {
				...d,
				card: this.questionCard(this.one('SELECT * FROM question WHERE id = ?', id)!, person),
				for: this.titled(d.targets)
			};
		return d;
	}
}
