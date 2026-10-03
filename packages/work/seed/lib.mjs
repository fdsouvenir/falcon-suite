// Small builder over the draft schema, used only to seed an evaluation database.
// It writes rows directly and appends an event per command, so the seeded history reads like
// the commands that would have produced it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function open(path, schemaPath) {
	rmSync(path, { force: true });
	const db = new DatabaseSync(path);
	db.exec(readFileSync(schemaPath, 'utf8'));
	const run = (sql, ...a) => db.prepare(sql).run(...a);
	const ev = (at, actor, command, kind, id, detail) =>
		run(
			'INSERT INTO event(at,actor,command,object_kind,object_id,detail) VALUES (?,?,?,?,?,?)',
			at,
			actor,
			command,
			kind,
			id,
			detail ? JSON.stringify(detail) : null
		);
	const id = () => randomUUID();
	const j = (v) => (v == null ? null : JSON.stringify(v));
	const link = (kind, sk, sid, tk, tid) =>
		run(
			'INSERT OR IGNORE INTO link(kind,source_kind,source_id,target_kind,target_id) VALUES (?,?,?,?,?)',
			kind,
			sk,
			sid,
			tk,
			tid
		);
	const AGENT = 'agent:verl';
	const FRED = 'person:fred';
	const sessionOf = (table, oid, key) =>
		key && run(`UPDATE ${table} SET session_key=?, session_linked_by=? WHERE id=?`, key, AGENT, oid);

	const api = {
		db,
		objective(o) {
			const oid = id();
			run(
				'INSERT INTO objective(id,title,statement,rank,status,autonomy,limits,owner,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
				oid,
				o.title,
				o.statement,
				o.rank ?? null,
				o.status ?? 'active',
				o.autonomy ?? 'propose',
				o.limits ?? null,
				FRED,
				o.at
			);
			ev(o.at, FRED, 'create', 'objective', oid);
			sessionOf('objective', oid, o.session);
			for (const k of o.kpis ?? []) {
				const kid = id();
				run(
					'INSERT INTO kpi(id,objective_id,name,unit,direction,target,target_date) VALUES (?,?,?,?,?,?,?)',
					kid,
					oid,
					k.name,
					k.unit,
					k.direction ?? 'up',
					k.target,
					k.target_date ?? null
				);
				for (const r of k.readings ?? [])
					run(
						'INSERT INTO kpi_reading(id,kpi_id,value,at,source) VALUES (?,?,?,?,?)',
						id(),
						kid,
						r.value,
						r.at,
						r.source
					);
			}
			for (const r of o.reviews ?? []) {
				run(
					'INSERT INTO objective_review(id,objective_id,author,at,moved,stalled,proposed,sources) VALUES (?,?,?,?,?,?,?,?)',
					id(),
					oid,
					AGENT,
					r.at,
					r.moved,
					r.stalled,
					r.proposed ?? null,
					j(r.sources)
				);
				ev(r.at, AGENT, 'review', 'objective', oid);
			}
			return oid;
		},
		area(a) {
			const aid = id();
			run(
				'INSERT INTO area(id,title,description,status,accountable_human) VALUES (?,?,?,?,?)',
				aid,
				a.title,
				a.description,
				'active',
				FRED
			);
			ev(a.at ?? '2026-09-08T00:00:00Z', FRED, 'create', 'area', aid);
			return aid;
		},
		project(pr) {
			const pid = id();
			run(
				'INSERT INTO project(id,title,outcome,area_id,accountable_human,abandoned_at,created_at) VALUES (?,?,?,?,?,?,?)',
				pid,
				pr.title,
				pr.outcome,
				pr.area,
				FRED,
				pr.abandoned_at ?? null,
				pr.at
			);
			ev(pr.at, pr.by ?? AGENT, 'create', 'project', pid);
			sessionOf('project', pid, pr.session);
			for (const o of pr.serves ?? []) link('serves', 'project', pid, 'objective', o);
			const ms = {};
			(pr.milestones ?? []).forEach((m, i) => {
				const mid = id();
				run(
					'INSERT INTO milestone(id,project_id,title,success_condition,ord,status,achieved_at,basis,sources) VALUES (?,?,?,?,?,?,?,?,?)',
					mid,
					pid,
					m.title,
					m.success_condition,
					i + 1,
					m.achieved ? 'achieved' : 'open',
					m.achieved?.at ?? null,
					m.achieved?.basis ?? null,
					j(m.achieved?.sources)
				);
				if (m.achieved) ev(m.achieved.at, AGENT, 'achieve', 'milestone', mid);
				ms[m.key ?? i + 1] = mid;
			});
			return { id: pid, ms };
		},
		task(t) {
			const tid = id();
			const at = t.at;
			const updated = t.updated ?? t.result?.at ?? at;
			run(
				`INSERT INTO task(id,area_id,project_id,milestone_id,status,agent,definition_rev,waiting_for,waiting_on_kind,waiting_on_ref,resume_when,follow_up_at,created_at,updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				tid,
				t.project ? null : t.area,
				t.project ?? null,
				t.milestone ?? null,
				t.status,
				t.agent === undefined ? AGENT : t.agent,
				(t.revisions?.length ?? 0) + 1,
				t.wait?.for ?? null,
				t.wait?.kind ?? null,
				t.wait?.ref ?? null,
				t.wait?.resume_when ?? null,
				t.wait?.follow_up_at ?? null,
				at,
				updated
			);
			run(
				'INSERT INTO task_definition(task_id,rev,title,description,done_when,reason,author,at) VALUES (?,?,?,?,?,?,?,?)',
				tid,
				1,
				t.title,
				t.description,
				t.done_when,
				null,
				t.by ?? AGENT,
				at
			);
			ev(at, t.by ?? AGENT, 'create', 'task', tid);
			sessionOf('task', tid, t.session);
			(t.revisions ?? []).forEach((r, i) => {
				run(
					'INSERT INTO task_definition(task_id,rev,title,description,done_when,reason,author,at) VALUES (?,?,?,?,?,?,?,?)',
					tid,
					i + 2,
					r.title ?? t.title,
					r.description ?? t.description,
					r.done_when ?? t.done_when,
					r.reason,
					AGENT,
					r.at
				);
				ev(r.at, AGENT, 'revise_definition', 'task', tid, { reason: r.reason });
			});
			if (t.plan) {
				run(
					'INSERT INTO task_plan(task_id,rev,definition_rev,content,author,at) VALUES (?,?,?,?,?,?)',
					tid,
					1,
					1,
					t.plan,
					AGENT,
					at
				);
				ev(at, AGENT, 'revise_plan', 'task', tid);
			}
			if (t.status === 'in_progress' || t.status === 'completed' || t.status === 'waiting')
				ev(at, AGENT, 'start', 'task', tid);
			if (t.status === 'waiting') ev(updated, AGENT, 'wait', 'task', tid, t.wait);
			if (t.result) {
				run(
					'INSERT INTO task_result(id,task_id,definition_rev,content,sources,accepted,author,at) VALUES (?,?,?,?,?,?,?,?)',
					id(),
					tid,
					(t.revisions?.length ?? 0) + 1,
					t.result.content,
					j(t.result.sources),
					t.status === 'completed' ? 1 : 0,
					AGENT,
					t.result.at
				);
				if (t.status === 'completed') ev(t.result.at, AGENT, 'complete', 'task', tid);
			}
			if (t.status === 'abandoned') ev(updated, t.abandoned_by ?? AGENT, 'abandon', 'task', tid);
			for (const o of t.serves ?? []) link('serves', 'task', tid, 'objective', o);
			for (const d of t.depends_on ?? []) link('depends_on', 'task', tid, 'task', d);
			for (const a of t.activity ?? [])
				run(
					'INSERT INTO activity(id,task_id,agent,at,kind,summary,ref) VALUES (?,?,?,?,?,?,?)',
					id(),
					tid,
					AGENT,
					a.at ?? updated,
					a.kind,
					a.summary,
					a.ref ?? null
				);
			return tid;
		},
		untracked(a) {
			run(
				'INSERT INTO activity(id,task_id,agent,at,kind,summary,ref) VALUES (?,?,?,?,?,?,?)',
				id(),
				null,
				AGENT,
				a.at,
				a.kind,
				a.summary,
				a.ref ?? null
			);
		},
		question(q) {
			const qid = id();
			run(
				`INSERT INTO question(id,prompt,impact,answerable_by,status,answer,confidence,answer_sources,hypothesis,created_by,created_at,resolved_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
				qid,
				q.prompt,
				q.impact,
				j(q.answerable_by ?? [FRED]),
				q.answer ? 'answered' : (q.status ?? 'open'),
				q.answer?.text ?? null,
				q.answer?.confidence ?? null,
				j(q.answer?.sources),
				q.hypothesis ?? null,
				AGENT,
				q.at,
				q.answer?.at ?? null
			);
			ev(q.at, AGENT, 'create', 'question', qid);
			if (q.answer) ev(q.answer.at, FRED, 'answer', 'question', qid);
			for (const [k, t] of q.targets ?? []) link('targets', 'question', qid, k, t);
			if (!q.answer && q.ask)
				api.ask({ kind: 'question', id: qid, prompt: q.prompt, at: q.at, conversation: q.ask });
			return qid;
		},
		decision(d) {
			const did = id();
			run(
				`INSERT INTO decision(id,prompt,options,recommendation,deciders,consequence_of_no_decision,status,chosen_option,rationale,decided_by,deferred_until,created_by,created_at,resolved_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				did,
				d.prompt,
				j(d.options),
				j(d.recommendation),
				j(d.deciders ?? [FRED]),
				d.consequence,
				d.decided ? 'decided' : (d.status ?? 'pending'),
				d.decided?.option ?? null,
				d.decided?.rationale ?? null,
				d.decided ? (d.decided.by ?? FRED) : null,
				d.deferred_until ?? null,
				AGENT,
				d.at,
				d.decided?.at ?? null
			);
			ev(d.at, AGENT, 'create', 'decision', did);
			if (d.decided) ev(d.decided.at, d.decided.by ?? FRED, 'decide', 'decision', did);
			for (const [k, t] of d.targets ?? []) link('targets', 'decision', did, k, t);
			if (!d.decided && d.ask)
				api.ask({ kind: 'decision', id: did, prompt: d.prompt, at: d.at, conversation: d.ask });
			return did;
		},
		finding(f) {
			const fid = id();
			run(
				'INSERT INTO finding(id,conclusion,confidence,sources,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
				fid,
				f.conclusion,
				f.confidence ?? 'supported',
				j(f.sources),
				'current',
				AGENT,
				f.at
			);
			ev(f.at, AGENT, 'create', 'finding', fid);
			for (const [k, t] of f.targets ?? []) link('targets', 'finding', fid, k, t);
			return fid;
		},
		ask(a) {
			run(
				'INSERT INTO ask(id,subject_kind,subject_id,addressed_to,session_key,session_linked_by,prompt,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
				id(),
				a.kind,
				a.id,
				a.to ?? FRED,
				typeof a.conversation === 'string' ? a.conversation : null,
				typeof a.conversation === 'string' ? AGENT : null,
				a.prompt,
				'pending',
				a.at
			);
		}
	};
	return api;
}
