import { Type } from 'typebox';
import { defineCommand, type Context } from '../engine.js';
import { reject } from '../types.js';
import {
	Id,
	Title,
	Text,
	Short,
	Reason,
	When,
	Who,
	Sources,
	Source,
	Target,
	Confidence,
	obj,
	opt,
	Empty
} from '../schemas.js';

const parse = <T>(v: unknown): T => JSON.parse(v as string) as T;

/** The discussion session an Ask about these targets should use (spec §9 fallback). */
function sessionFor(ctx: Context, targets: { kind: string; id: string }[]): string | null {
	for (const t of targets) {
		if (t.kind === 'task') {
			const r = ctx.one<{ session_key: string | null; project_id: string | null }>(
				'SELECT session_key, project_id FROM task WHERE id = ?',
				t.id
			);
			if (r?.session_key) return r.session_key;
			if (r?.project_id) {
				const p = ctx.one<{ session_key: string | null }>(
					'SELECT session_key FROM project WHERE id = ?',
					r.project_id
				);
				if (p?.session_key) return p.session_key;
			}
		} else if (t.kind === 'project' || t.kind === 'objective') {
			const r = ctx.one<{ session_key: string | null }>(
				`SELECT session_key FROM ${t.kind} WHERE id = ?`,
				t.id
			);
			if (r?.session_key) return r.session_key;
		}
	}
	return null;
}

function addTargets(
	ctx: Context,
	kind: string,
	id: string,
	targets: { kind: 'objective' | 'project' | 'milestone' | 'task'; id: string }[] = []
) {
	for (const t of targets) {
		ctx.get(t.kind, t.id);
		ctx.link('targets', kind, id, t.kind, t.id);
	}
}
const targetsOf = (ctx: Context, id: string) =>
	ctx.all<{ kind: string; id: string }>(
		"SELECT target_kind AS kind, target_id AS id FROM link WHERE kind = 'targets' AND source_id = ?",
		id
	);

const Option = obj({
	id: Type.String({ minLength: 1, maxLength: 64 }),
	label: Title,
	summary: opt(Short),
	risks: opt(Short),
	tradeoffs: opt(Short)
});
const DecisionBody = {
	prompt: Short,
	options: Type.Array(Option, { minItems: 2, maxItems: 20 }),
	recommendation: obj({ option: Type.String({ minLength: 1, maxLength: 64 }), rationale: Short }),
	deciders: Type.Array(Who, { minItems: 1, maxItems: 20 }),
	consequence_of_no_decision: Short
};
function checkDecisionBody(i: any) {
	const ids = i.options.map((o: { id: string }) => o.id);
	if (new Set(ids).size !== ids.length) reject('duplicate_option', 'Option ids must be unique');
	if (!ids.includes(i.recommendation.option))
		reject('unknown_option', 'The recommendation must name one of the options');
}

export const knowledgeCommands = [
	defineCommand({
		name: 'raise_question',
		summary: 'Record missing knowledge and who can supply it. People listed get an Ask.',
		input: obj({
			prompt: Short,
			impact: Short,
			answerable_by: Type.Array(Who, { minItems: 1, maxItems: 20 }),
			targets: opt(Type.Array(Target, { maxItems: 50 })),
			hypothesis: opt(Text)
		}),
		run(ctx, i) {
			const id = ctx.newId();
			ctx.insert('question', {
				id,
				prompt: i.prompt,
				impact: i.impact,
				answerable_by: i.answerable_by,
				status: 'open',
				hypothesis: i.hypothesis ?? null,
				hypothesis_by: i.hypothesis ? ctx.actor.id : null,
				created_by: ctx.actor.id,
				created_at: ctx.now,
				version: 1
			});
			addTargets(ctx, 'question', id, i.targets);
			ctx.event('question', id, 1);
			const session = sessionFor(ctx, i.targets ?? []);
			for (const who of i.answerable_by)
				if (who.startsWith('person:') && who !== ctx.actor.id)
					ctx.ask('question', id, who, i.prompt, session);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'add_hypothesis',
		on: 'question',
		summary:
			'Record a hypothesis while a Question is open. Shown as a hypothesis, never as the answer.',
		input: obj({ text: Text }),
		run(ctx, i, q) {
			if (q!.status !== 'open') reject('not_open', `Question is ${q!.status}`);
			const v = ctx.update('question', q!.id as string, {
				hypothesis: i.text,
				hypothesis_by: ctx.actor.id
			});
			ctx.event('question', q!.id as string, v, { hypothesis: i.text });
			ctx.done(q!.id as string, v);
		}
	}),
	defineCommand({
		name: 'answer',
		on: 'question',
		summary: 'Answer a Question. A later answer supersedes an earlier one; history is kept.',
		input: obj({
			answer: Text,
			confidence: opt(Confidence),
			sources: opt(Type.Array(Source, { maxItems: 50 }))
		}),
		run(ctx, i, q) {
			answer(ctx, q!, i.answer, i.confidence, i.sources ?? [], false);
		}
	}),
	defineCommand({
		name: 'accept_hypothesis',
		on: 'question',
		humanOnly: true,
		summary: "Accept the agent's hypothesis as your confirmed answer.",
		input: Empty,
		run(ctx, _i, q) {
			if (!q!.hypothesis) reject('no_hypothesis', 'This Question has no hypothesis');
			answer(ctx, q!, q!.hypothesis as string, 'confirmed', [], true);
		}
	}),
	defineCommand({
		name: 'withdraw_question',
		on: 'question',
		summary: 'Withdraw a Question that no longer matters.',
		input: obj({ reason: Reason }),
		run(ctx, i, q) {
			if (q!.status === 'withdrawn') return ctx.nothing(q!.id as string, q!.version as number);
			const v = ctx.update('question', q!.id as string, {
				status: 'withdrawn',
				withdrawn_reason: i.reason
			});
			ctx.event('question', q!.id as string, v, { reason: i.reason });
			ctx.resolveAsks(q!.id as string, 'dismissed');
			ctx.done(q!.id as string, v);
		}
	}),

	defineCommand({
		name: 'raise_decision',
		summary:
			'Put a choice to its deciders, with options and a recommendation. People deciding get an Ask.',
		input: obj({ ...DecisionBody, targets: opt(Type.Array(Target, { maxItems: 50 })) }),
		run(ctx, i) {
			checkDecisionBody(i);
			const id = ctx.newId();
			ctx.insert('decision', {
				id,
				prompt: i.prompt,
				options: i.options,
				recommendation: i.recommendation,
				deciders: i.deciders,
				consequence_of_no_decision: i.consequence_of_no_decision,
				status: 'pending',
				created_by: ctx.actor.id,
				created_at: ctx.now,
				version: 1
			});
			addTargets(ctx, 'decision', id, i.targets);
			ctx.event('decision', id, 1);
			const session = sessionFor(ctx, i.targets ?? []);
			for (const who of i.deciders)
				if (who.startsWith('person:') && who !== ctx.actor.id)
					ctx.ask('decision', id, who, i.prompt, session);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'revise_decision',
		on: 'decision',
		summary: 'Revise a pending Decision.',
		input: obj({ ...DecisionBody, reason: Reason }),
		run(ctx, i, d) {
			if (d!.status !== 'pending') reject('not_pending', `Decision is ${d!.status}`);
			checkDecisionBody(i);
			const { reason, ...body } = i;
			const v = ctx.update('decision', d!.id as string, body);
			ctx.event('decision', d!.id as string, v, { reason });
			ctx.done(d!.id as string, v);
		}
	}),
	defineCommand({
		name: 'decide',
		on: 'decision',
		summary: 'Decide. Agents must give a rationale; for people it is optional.',
		input: obj({ option: Type.String({ minLength: 1, maxLength: 64 }), rationale: opt(Short) }),
		run(ctx, i, d) {
			if (d!.status === 'decided' && d!.chosen_option === i.option)
				return ctx.nothing(d!.id as string, d!.version as number);
			if (!['pending', 'deferred'].includes(d!.status as string))
				reject('not_pending', `Decision is ${d!.status}`);
			if (!parse<string[]>(d!.deciders).includes(ctx.actor.id))
				reject('not_a_decider', 'You are not one of the deciders');
			if (!parse<{ id: string }[]>(d!.options).some((o) => o.id === i.option))
				reject('unknown_option', 'No such option');
			if (ctx.actor.kind === 'agent' && !i.rationale)
				reject('rationale_required', 'Agents give a rationale when deciding');
			const v = ctx.update('decision', d!.id as string, {
				status: 'decided',
				chosen_option: i.option,
				rationale: i.rationale ?? null,
				decided_by: ctx.actor.id,
				resolved_at: ctx.now,
				deferred_until: null
			});
			ctx.event('decision', d!.id as string, v, { option: i.option });
			ctx.resolveAsks(d!.id as string);
			ctx.done(d!.id as string, v);
		}
	}),
	defineCommand({
		name: 'defer_decision',
		on: 'decision',
		summary: 'Defer a Decision until a date.',
		input: obj({ until: When, reason: Reason }),
		run(ctx, i, d) {
			if (!['pending', 'deferred'].includes(d!.status as string))
				reject('not_pending', `Decision is ${d!.status}`);
			if (!parse<string[]>(d!.deciders).includes(ctx.actor.id))
				reject('not_a_decider', 'You are not one of the deciders');
			const v = ctx.update('decision', d!.id as string, {
				status: 'deferred',
				deferred_until: i.until,
				closed_reason: i.reason
			});
			ctx.event('decision', d!.id as string, v, i);
			ctx.done(d!.id as string, v);
		}
	}),
	defineCommand({
		name: 'withdraw_decision',
		on: 'decision',
		summary: 'Withdraw a Decision that is no longer needed.',
		input: obj({ reason: Reason }),
		run(ctx, i, d) {
			if (d!.status === 'withdrawn') return ctx.nothing(d!.id as string, d!.version as number);
			if (d!.status === 'decided' || d!.status === 'superseded')
				reject('closed', `Decision is ${d!.status}`, ['supersede_decision']);
			const v = ctx.update('decision', d!.id as string, {
				status: 'withdrawn',
				closed_reason: i.reason,
				resolved_at: ctx.now
			});
			ctx.event('decision', d!.id as string, v, { reason: i.reason });
			ctx.resolveAsks(d!.id as string, 'dismissed');
			ctx.done(d!.id as string, v);
		}
	}),
	defineCommand({
		name: 'supersede_decision',
		on: 'decision',
		summary: 'Replace a Decision with a newer one.',
		input: obj({ successor: Id, reason: Reason }),
		run(ctx, i, d) {
			if (i.successor === d!.id) reject('self', 'A Decision cannot supersede itself');
			ctx.get('decision', i.successor);
			const v = ctx.update('decision', d!.id as string, {
				status: 'superseded',
				superseded_by: i.successor,
				closed_reason: i.reason,
				resolved_at: ctx.now
			});
			ctx.event('decision', d!.id as string, v, i);
			ctx.resolveAsks(d!.id as string, 'dismissed');
			ctx.done(d!.id as string, v);
		}
	}),

	defineCommand({
		name: 'record_finding',
		summary: 'Record something learned, with evidence.',
		input: obj({
			conclusion: Text,
			confidence: Confidence,
			sources: Sources,
			targets: opt(Type.Array(Target, { maxItems: 50 }))
		}),
		run(ctx, i) {
			const id = ctx.newId();
			ctx.insert('finding', {
				id,
				conclusion: i.conclusion,
				confidence: i.confidence,
				sources: i.sources,
				status: 'current',
				created_by: ctx.actor.id,
				created_at: ctx.now,
				version: 1
			});
			addTargets(ctx, 'finding', id, i.targets);
			ctx.event('finding', id, 1);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'retract_finding',
		on: 'finding',
		summary: 'Retract a Finding that turned out wrong.',
		input: obj({ reason: Reason }),
		run(ctx, i, f) {
			if (f!.status === 'retracted') return ctx.nothing(f!.id as string, f!.version as number);
			const v = ctx.update('finding', f!.id as string, {
				status: 'retracted',
				closed_reason: i.reason
			});
			ctx.event('finding', f!.id as string, v, { reason: i.reason });
			ctx.done(f!.id as string, v);
		}
	}),
	defineCommand({
		name: 'supersede_finding',
		on: 'finding',
		summary: 'Replace a Finding with a newer one.',
		input: obj({ successor: Id, reason: Reason }),
		run(ctx, i, f) {
			if (i.successor === f!.id) reject('self', 'A Finding cannot supersede itself');
			ctx.get('finding', i.successor);
			const v = ctx.update('finding', f!.id as string, {
				status: 'superseded',
				superseded_by: i.successor,
				closed_reason: i.reason
			});
			ctx.event('finding', f!.id as string, v, i);
			ctx.done(f!.id as string, v);
		}
	}),
	defineCommand({
		name: 'dismiss_ask',
		on: 'ask',
		summary: 'Dismiss an Ask. The Question or Decision behind it stays open.',
		input: obj({ reason: Reason }),
		run(ctx, i, a) {
			if (a!.status !== 'pending') return ctx.nothing(a!.id as string, a!.version as number);
			const v = ctx.update('ask', a!.id as string, {
				status: 'dismissed',
				dismissed_reason: i.reason,
				resolved_at: ctx.now
			});
			ctx.event('ask', a!.id as string, v, { reason: i.reason });
			ctx.done(a!.id as string, v);
		}
	})
];

function answer(
	ctx: Context,
	q: Record<string, unknown>,
	text: string,
	confidence: string | undefined,
	sources: unknown[],
	accepted: boolean
) {
	if (q.status === 'withdrawn') reject('withdrawn', 'The Question was withdrawn');
	if (!parse<string[]>(q.answerable_by).includes(ctx.actor.id))
		reject('not_answerable', 'You are not listed as able to answer this Question');
	const id = ctx.newId();
	ctx.insert('answer', {
		id,
		question_id: q.id,
		text,
		confidence: confidence ?? (ctx.actor.kind === 'human' ? 'confirmed' : 'supported'),
		sources,
		accepted_hypothesis: accepted ? 1 : 0,
		author: ctx.actor.id,
		at: ctx.now
	});
	const v = ctx.update('question', q.id as string, { status: 'answered' });
	ctx.event('question', q.id as string, v, {
		answer: id,
		...(accepted ? { accepted_hypothesis: true } : {})
	});
	ctx.resolveAsks(q.id as string);
	ctx.done(q.id as string, v, { answer: id });
}

export { sessionFor, targetsOf };
