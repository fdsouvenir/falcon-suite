import type { Reads } from '../store/reads.js';

/** Static guidance, cacheable in the system prompt. Kept short on purpose (spec §10). */
export const GUIDANCE = `Falcon Work is where you record what you do for the people you work for.
- Before changing anything for a request, have a Task in progress (falcon_work: create_task, then start). Small read-only turns need nothing.
- Say why: definition of done when you create a Task; a Result with evidence when you complete it.
- Unknowns go in a Question, choices someone must approve in a Decision, things learned in a Finding.
- What you actually do is captured automatically; you never need to restate it.
- Read with falcon_work_read (brief, needs_you, objectives, get, list, activity, warnings, help). Change with falcon_work.`;

/** The per-turn brief for one agent, as compact text. Empty sections are omitted. */
export function renderBrief(
	reads: Reads,
	agent: string,
	since: string | null,
	now: string
): string {
	const b = reads.brief(agent, since, now);
	const lines: string[] = ['Falcon Work — your brief'];
	if (b.objectives.length)
		lines.push(
			'Objectives (by rank): ' +
				b.objectives
					.map(
						(o) =>
							`#${o.rank} ${o.title} [${o.autonomy}${o.last_progress ? `, last progress ${o.last_progress.slice(0, 10)}` : ', no progress yet'}]`
					)
					.join('; ')
		);
	for (const t of b.in_progress)
		lines.push(
			`In progress: ${t.title} (${t.id})${t.blocked_by.length ? ` — blocked: ${t.blocked_by.join('; ')}` : ''}`
		);
	for (const t of b.waiting)
		lines.push(
			`Waiting: ${t.title} (${t.id}) — ${t.waiting_for}${t.follow_up_at ? `, follow up ${t.follow_up_at.slice(0, 10)}` : ''}`
		);
	for (const r of b.resolved_for_you as {
		kind: string;
		by: string;
		prompt: string;
		answer?: string;
		chosen?: string;
	}[])
		lines.push(
			r.kind === 'answer'
				? `Answered by ${r.by}: "${r.prompt}" → ${r.answer}`
				: `Decided by ${r.by}: "${r.prompt}" → ${r.chosen}`
		);
	for (const a of b.asks_for_you) lines.push(`Asked of you: ${a.prompt} (ask ${a.id})`);
	for (const w of b.warnings.slice(0, 5))
		lines.push(`Warning — ${w.kind.replace(/_/g, ' ')}: ${w.title}. ${w.detail}`);
	if (b.warnings.length > 5)
		lines.push(`…and ${b.warnings.length - 5} more warnings (falcon_work_read warnings).`);
	if (!b.in_progress.length) lines.push('You have no Task in progress.');
	return lines.join('\n');
}
