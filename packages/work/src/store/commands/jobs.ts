import { Type } from 'typebox';
import { defineCommand } from '../engine.js';
import { reject } from '../types.js';
import { Id, Title, Text, Short, Reason, Who, obj, opt } from '../schemas.js';

const Automation = obj({
	id: Type.String({ minLength: 1, maxLength: 256 }),
	name: opt(Title)
});

/** Jobs: ongoing duties an agent carries out (spec §2). OpenClaw automations run them. */
export const jobCommands = [
	defineCommand({
		name: 'create_job',
		summary:
			'Create a Job: an ongoing duty an agent carries out, never finished (e.g. "watch the support inbox and draft a reply to everything"). Link the OpenClaw automations that run it.',
		input: obj({
			title: Title,
			instructions: Text,
			agent: opt(Who),
			automations: opt(Type.Array(Automation, { maxItems: 20 })),
			status_line: opt(Short)
		}),
		run(ctx, i) {
			if (i.agent && !i.agent.startsWith('agent:'))
				reject('not_an_agent', 'Jobs are carried out by agents');
			const id = ctx.newId();
			ctx.insert('job', {
				id,
				title: i.title,
				instructions: i.instructions,
				status: 'active',
				agent: i.agent ?? (ctx.actor.kind === 'agent' ? ctx.actor.id : null),
				status_line: i.status_line ?? null,
				status_line_at: i.status_line ? ctx.now : null,
				created_at: ctx.now,
				updated_at: ctx.now,
				version: 1
			});
			for (const f of ['title', 'instructions', ...(i.status_line ? ['status_line'] : [])])
				ctx.markWritten(id, f);
			for (const a of i.automations ?? [])
				ctx.run(
					'INSERT OR IGNORE INTO job_automation (job_id, automation_id, name) VALUES (?,?,?)',
					id,
					a.id,
					a.name ?? null
				);
			ctx.event(
				'job',
				id,
				1,
				i.automations?.length
					? { automations: i.automations.map((a: { id: string }) => a.id) }
					: undefined
			);
			ctx.done(id, 1);
		}
	}),
	defineCommand({
		name: 'edit_job',
		on: 'job',
		summary: "Change a Job's title or instructions.",
		input: obj({ title: opt(Title), instructions: opt(Text), reason: opt(Reason) }),
		run(ctx, i, j) {
			const { reason, ...rest } = i;
			if (rest.title === undefined && rest.instructions === undefined)
				reject('nothing_to_change', 'Give a title or instructions');
			const { version, written } = ctx.writeFields('job', j!.id as string, rest, {
				updated_at: ctx.now
			});
			if (version === null) return ctx.nothing(j!.id as string, j!.version as number);
			ctx.event('job', j!.id as string, version, { ...written, reason });
			ctx.done(j!.id as string, version);
		}
	}),
	...(
		[
			[
				'pause_job',
				'paused',
				['active'],
				'Pause a Job: its work stops being expected until resumed.'
			],
			['resume_job', 'active', ['paused'], 'Resume a paused Job.'],
			['retire_job', 'retired', ['active', 'paused'], 'Retire a Job that is no longer needed.']
		] as const
	).map(([name, to, from, summary]) =>
		defineCommand({
			name,
			on: 'job',
			summary,
			input: obj({ reason: opt(Reason) }),
			run(ctx, i, j) {
				if (j!.status === to) return ctx.nothing(j!.id as string, j!.version as number);
				if (!(from as readonly string[]).includes(j!.status as string))
					reject('wrong_status', `The Job is ${j!.status}`);
				const v = ctx.update('job', j!.id as string, { status: to, updated_at: ctx.now });
				ctx.event('job', j!.id as string, v, { from: j!.status, to, reason: i.reason });
				ctx.done(j!.id as string, v);
			}
		})
	),
	defineCommand({
		name: 'link_automation',
		on: 'job',
		summary:
			'Record that an OpenClaw automation runs this Job. Its runs are then filed under the Job.',
		input: Automation,
		run(ctx, i, j) {
			const other = ctx.one<{ job_id: string }>(
				'SELECT job_id FROM job_automation WHERE automation_id = ? AND job_id <> ?',
				i.id,
				j!.id as string
			);
			if (other) reject('automation_linked', 'That automation already runs another Job');
			if (
				ctx.one(
					'SELECT 1 FROM job_automation WHERE job_id = ? AND automation_id = ?',
					j!.id as string,
					i.id
				)
			)
				return ctx.nothing(j!.id as string, j!.version as number);
			ctx.run(
				'INSERT INTO job_automation (job_id, automation_id, name) VALUES (?,?,?)',
				j!.id as string,
				i.id,
				i.name ?? null
			);
			const v = ctx.update('job', j!.id as string, { updated_at: ctx.now });
			ctx.event('job', j!.id as string, v, { automation: i.id });
			ctx.done(j!.id as string, v);
		}
	}),
	defineCommand({
		name: 'unlink_automation',
		on: 'job',
		summary: 'Remove an automation from a Job.',
		input: obj({ id: Id }),
		run(ctx, i, j) {
			if (
				!ctx.one(
					'SELECT 1 FROM job_automation WHERE job_id = ? AND automation_id = ?',
					j!.id as string,
					i.id
				)
			)
				return ctx.nothing(j!.id as string, j!.version as number);
			ctx.run(
				'DELETE FROM job_automation WHERE job_id = ? AND automation_id = ?',
				j!.id as string,
				i.id
			);
			const v = ctx.update('job', j!.id as string, { updated_at: ctx.now });
			ctx.event('job', j!.id as string, v, { unlinked: i.id });
			ctx.done(j!.id as string, v);
		}
	})
];
