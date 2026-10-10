import type { Reads } from '../store/reads.js';

/** Static guidance, cacheable in the system prompt. Kept short on purpose (spec §10). */
export const GUIDANCE = `Falcon Work is the person's view of your work: their Objectives (what they want progress toward), Areas (standing responsibilities), Projects (outcomes, reached through ordered Milestones), Tasks (units of work with a definition of done), and the Questions, Decisions and Findings around them. Your brief each turn shows what is there. The falcon_work_* tools describe what each one does. Work records what each turn changes on its own, under the session's Task; your falcon_work calls add to or correct that record.
If Falcon Work errors or is unavailable, do what was asked anyway.`;

/** The per-turn brief for one agent, as compact text. Empty sections are omitted. */
export function renderBrief(
	reads: Reads,
	agent: string,
	since: string | null,
	now: string,
	/** The Task this session's work is recorded under, if any. */
	sessionTask: { id: string; title: string } | null = null
): string {
	const b = reads.brief(agent, since, now);
	const lines: string[] = ['Falcon Work — your brief'];
	if (sessionTask)
		lines.push(`This session's work is recorded under: ${sessionTask.title} (${sessionTask.id})`);
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
	if (b.structure.length) {
		lines.push('Where work lives (Area › open Projects):');
		for (const a of b.structure)
			lines.push(
				`- ${a.title} (${a.id})${a.projects.length ? '' : ': no open Projects'}` +
					a.projects
						.map(
							(p) =>
								`\n  · ${p.title} (${p.id})${p.serves.length ? ` serves ${p.serves.map((r) => `#${r}`).join(', ')}` : ''}${p.milestone ? `; at Milestone ${p.milestone.position}/${p.milestone.of} "${p.milestone.title}"` : ''}; ${p.open_tasks} open Task${p.open_tasks === 1 ? '' : 's'}`
						)
						.join('')
			);
	}
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
	// Unfiled work is the record keeper's, not the agent's, to sort out.
	const warnings = b.warnings.filter((w) => w.kind !== 'unfiled_work');
	for (const w of warnings.slice(0, 5))
		lines.push(`Warning — ${w.kind.replace(/_/g, ' ')}: ${w.title}. ${w.detail}`);
	if (warnings.length > 5)
		lines.push(`…and ${warnings.length - 5} more warnings (falcon_work_read warnings).`);
	return lines.join('\n');
}
