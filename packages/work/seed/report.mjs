// Render the human's view (spec §10) from a Work 5 database as Markdown.
//   node report.mjs <db> > view.md
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2] ?? 'work-seed.db', { readOnly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const out = [];
const p = (s = '') => out.push(s);
const who = (ref) => ref.replace(/^(person|agent):/, '');
const day = (t) => (t ? t.slice(0, 10) : '');
const title = (id) => one('SELECT title FROM task_definition WHERE task_id=? ORDER BY rev DESC', id)?.title;
const src = (json) =>
	JSON.parse(json ?? '[]')
		.map((s) => s.label ?? s.ref)
		.join('; ');

// Objectives a task serves: directly, or through its Project.
const servesOf = (taskId) =>
	all(
		`SELECT target_id id FROM link WHERE kind='serves' AND source_id=?
		 UNION SELECT l.target_id FROM task t JOIN link l ON l.kind='serves' AND l.source_id=t.project_id WHERE t.id=?`,
		taskId,
		taskId
	).map((r) => r.id);

const blockers = (taskId) => {
	const why = [];
	for (const d of all(
		`SELECT l.target_id id FROM link l WHERE l.kind='depends_on' AND l.source_id=?`,
		taskId
	)) {
		const t = one('SELECT status FROM task WHERE id=?', d.id);
		if (t && !['completed', 'abandoned'].includes(t.status)) why.push(`depends on "${title(d.id)}"`);
	}
	for (const q of all(
		`SELECT q.prompt FROM link l JOIN question q ON q.id=l.source_id WHERE l.kind='targets' AND l.target_id=? AND q.status='open'`,
		taskId
	))
		why.push(`open Question: ${q.prompt}`);
	for (const d of all(
		`SELECT d.prompt FROM link l JOIN decision d ON d.id=l.source_id WHERE l.kind='targets' AND l.target_id=? AND d.status='pending'`,
		taskId
	))
		why.push(`pending Decision: ${d.prompt}`);
	return why;
};

const projectStatus = (pr) => {
	if (pr.abandoned_at) return 'abandoned';
	const ms = all('SELECT status FROM milestone WHERE project_id=?', pr.id);
	return ms.length && ms.every((m) => m.status === 'achieved') ? 'completed' : 'open';
};

p('# Work — seeded view');
p();
p(`_Generated from \`${process.argv[2] ?? 'work-seed.db'}\`. This is the Work tab's content rendered as text (spec §10)._`);
p();

// 1. Objectives
p('## 1. Objectives');
p();
// Last progress: the most recent completed Task serving the Objective, directly or via its Project.
const today = '2026-10-01';
const lastProgress = new Map();
for (const t of all("SELECT id, updated_at FROM task WHERE status='completed'"))
	for (const o of servesOf(t.id))
		if ((lastProgress.get(o) ?? '') < t.updated_at) lastProgress.set(o, t.updated_at);
const since = (o) => {
	const at = lastProgress.get(o.id);
	if (!at) return `none since it was set on ${day(o.created_at)}`;
	const days = Math.round((Date.parse(today) - Date.parse(day(at))) / 864e5);
	return `${day(at)} (${days} days ago)`;
};
for (const o of all("SELECT * FROM objective ORDER BY status<>'active', rank")) {
	p(`### ${o.rank ? `#${o.rank} ` : ''}${o.title} — _${o.status}_`);
	p();
	p(`> ${o.statement}`);
	p();
	p(
		`Owner: ${who(o.owner)} · Autonomy: **${o.autonomy}**${o.limits ? ` (limits: ${o.limits})` : ''} · Last progress: **${since(o)}**`
	);
	p();
	const kpis = all('SELECT * FROM kpi WHERE objective_id=?', o.id);
	if (kpis.length) {
		p('| KPI | Latest | Target | Readings |');
		p('| --- | --- | --- | --- |');
		for (const k of kpis) {
			const rs = all('SELECT * FROM kpi_reading WHERE kpi_id=? ORDER BY at', k.id);
			const last = rs.at(-1);
			p(
				`| ${k.name} | ${last ? `${last.value} ${k.unit} (${day(last.at)})` : '_unmeasured_'} | ${k.direction === 'up' ? '≥' : k.direction === 'down' ? '≤' : '='} ${k.target} ${k.unit}${k.target_date ? ` by ${k.target_date}` : ''} | ${rs.length} |`
			);
		}
		p();
	}
	const rv = one('SELECT * FROM objective_review WHERE objective_id=? ORDER BY at DESC', o.id);
	if (rv) {
		p(`**Latest review** (${day(rv.at)}, ${who(rv.author)})`);
		p(`- Moved: ${rv.moved}`);
		p(`- Stalled: ${rv.stalled}`);
		if (rv.proposed) p(`- Proposed: ${rv.proposed}`);
		p(`- Sources: ${src(rv.sources)}`);
		p();
	}
	const projects = all(
		"SELECT p.* FROM link l JOIN project p ON p.id=l.source_id WHERE l.kind='serves' AND l.target_id=?",
		o.id
	);
	const tasks = all(
		"SELECT t.id, t.status FROM link l JOIN task t ON t.id=l.source_id WHERE l.kind='serves' AND l.target_id=? AND t.project_id IS NULL",
		o.id
	);
	if (projects.length || tasks.length) {
		p('Serving it:');
		for (const pr of projects) {
			const n = all('SELECT status FROM task WHERE project_id=?', pr.id);
			const done = n.filter((t) => t.status === 'completed').length;
			p(`- Project **${pr.title}** — ${projectStatus(pr)} · ${done}/${n.length} Tasks completed`);
		}
		for (const t of tasks) p(`- Task ${title(t.id)} — ${t.status}`);
		p();
	}
}

// 2. Needs you
p('## 2. Needs you');
p();
const asks = all("SELECT * FROM ask WHERE status='pending' ORDER BY created_at");
const askedIn = (kind, sid) => {
	const a = asks.find((x) => x.subject_kind === kind && x.subject_id === sid);
	return a ? ` · _asked in ${a.conversation}_` : ' · _not yet asked_';
};
const qs = all("SELECT * FROM question WHERE status='open' ORDER BY created_at");
const ds = all("SELECT * FROM decision WHERE status='pending' ORDER BY created_at");
for (const d of ds) {
	const opts = JSON.parse(d.options);
	const rec = JSON.parse(d.recommendation);
	p(`- **Decision** (${day(d.created_at)}): ${d.prompt}${askedIn('decision', d.id)}`);
	p(`  - Options: ${opts.map((x) => x.label).join(' · ')}`);
	p(`  - Recommended: ${opts.find((x) => x.id === rec.option)?.label} — ${rec.rationale}`);
	p(`  - If nobody decides: ${d.consequence_of_no_decision}`);
}
for (const q of qs) {
	p(`- **Question** (${day(q.created_at)}): ${q.prompt}${askedIn('question', q.id)}`);
	p(`  - Holding up: ${q.impact}`);
	if (q.hypothesis) p(`  - Agent's hypothesis meanwhile: ${q.hypothesis}`);
}
for (const a of asks.filter((x) => !['question', 'decision'].includes(x.subject_kind)))
	p(`- **Ask** to ${who(a.addressed_to)} in ${a.conversation} (${day(a.created_at)}): ${a.prompt}`);
if (!asks.length && !qs.length && !ds.length) p('_Nothing._');
p();

// 3. Now
p('## 3. Now — in progress');
p();
for (const t of all("SELECT * FROM task WHERE status='in_progress' ORDER BY agent, updated_at DESC")) {
	const b = blockers(t.id);
	p(`- **${who(t.agent)}** — ${title(t.id)}${b.length ? ` _(blocked: ${b.join('; ')})_` : ''}`);
}
p();

// 4. Waiting
p('## 4. Waiting');
p();
for (const t of all("SELECT * FROM task WHERE status='waiting' ORDER BY follow_up_at")) {
	p(`- ${title(t.id)} — waiting on **${who(t.waiting_on_ref)}** (${t.waiting_on_kind})`);
	p(`  - ${t.waiting_for}`);
	p(`  - Resume when: ${t.resume_when}${t.follow_up_at ? ` · follow up ${day(t.follow_up_at)}` : ''}`);
}
p();

// 5. Recently completed
p('## 5. Recently completed');
p();
for (const t of all("SELECT * FROM task WHERE status='completed' ORDER BY updated_at DESC LIMIT 25")) {
	const r = one('SELECT * FROM task_result WHERE task_id=? AND accepted=1', t.id);
	p(`- **${title(t.id)}** (${day(t.updated_at)}, ${t.agent ? who(t.agent) : 'unassigned'})`);
	if (r) p(`  - Result: ${r.content}`);
	if (r) p(`  - Evidence: ${src(r.sources)}`);
}
p();

// 6. Untracked
p('## 6. Untracked activity');
p();
const un = all('SELECT * FROM activity WHERE task_id IS NULL ORDER BY at DESC');
for (const a of un) p(`- ${day(a.at)} ${who(a.agent)} · ${a.kind}: ${a.summary}${a.ref ? ` (${a.ref})` : ''}`);
if (!un.length) p('_Nothing — every recorded action is explained by a Task._');
p();

// 7. Areas and Projects
p('## 7. Areas and Projects');
p();
for (const a of all("SELECT * FROM area WHERE status='active' ORDER BY title")) {
	p(`### ${a.title}`);
	p();
	p(`_${a.description}_ — accountable: ${who(a.accountable_human)}`);
	p();
	for (const pr of all('SELECT * FROM project WHERE area_id=? ORDER BY created_at', a.id)) {
		const ms = all('SELECT * FROM milestone WHERE project_id=? ORDER BY ord', pr.id);
		p(`- **Project: ${pr.title}** — ${projectStatus(pr)}`);
		p(`  - Outcome: ${pr.outcome}`);
		for (const m of ms) {
			p(`  - Milestone ${m.ord}. ${m.title} — ${m.status}`);
			for (const t of all('SELECT * FROM task WHERE milestone_id=?', m.id))
				p(`    - [${t.status}] ${title(t.id)}`);
		}
		for (const t of all('SELECT * FROM task WHERE project_id=? AND milestone_id IS NULL', pr.id))
			p(`  - [${t.status}] ${title(t.id)}`);
	}
	for (const t of all('SELECT * FROM task WHERE area_id=? ORDER BY created_at', a.id))
		p(`- [${t.status}] ${title(t.id)}`);
	p();
}

// Knowledge
p('## Findings and settled Decisions');
p();
for (const f of all("SELECT * FROM finding WHERE status='current' ORDER BY created_at DESC"))
	p(`- **Finding** (${f.confidence}, ${day(f.created_at)}): ${f.conclusion} — _${src(f.sources)}_`);
for (const d of all("SELECT * FROM decision WHERE status='decided' ORDER BY resolved_at DESC")) {
	const opt = JSON.parse(d.options).find((x) => x.id === d.chosen_option);
	p(`- **Decision** (${day(d.resolved_at)}, ${who(d.decided_by)}): ${d.prompt} → **${opt?.label}**. ${d.rationale}`);
}
for (const q of all("SELECT * FROM question WHERE status='answered' ORDER BY resolved_at DESC"))
	p(`- **Answered** (${day(q.resolved_at)}): ${q.prompt} → ${q.answer}`);

console.log(out.join('\n'));
