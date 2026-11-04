/**
 * The writer (spec §3.4): one tool-free model call per session pass, for what Jev and code cannot
 * do — words for new work, a Project's shape, and cases left unsettled. It returns edits; the clerk
 * checks them with Jev and applies them through the store's commands.
 */

export type Edit =
	| {
			op: 'create_task';
			key?: string;
			title: string;
			description: string;
			done_when: string;
			project?: string;
			milestone?: string;
			job?: string;
			status_line?: string;
	  }
	| {
			op: 'create_project';
			key?: string;
			title: string;
			outcome: string;
			status_line?: string;
			milestones?: { title: string; success_condition: string }[];
	  }
	| { op: 'create_job'; key?: string; title: string; instructions: string; status_line?: string }
	| { op: 'attach_task'; task: string; project?: string; job?: string; milestone?: string }
	| { op: 'promote_to_project'; task: string; outcome: string }
	| { op: 'status_line'; item: string; text: string }
	| { op: 'complete'; task: string; result: string }
	| { op: 'wait'; task: string; waiting_for: string; on: 'person' | 'external'; who?: string }
	| { op: 'achieve_milestone'; milestone: string; basis: string }
	| { op: 'raise_question'; about?: string; prompt: string; impact?: string }
	| { op: 'withdraw_question'; question: string; reason: string }
	| { op: 'record_answer'; question: string; answer: string }
	| {
			op: 'finding';
			about?: string;
			conclusion: string;
			confidence?: 'tentative' | 'supported' | 'confirmed';
	  }
	| { op: 'entry'; item: string; summary: string };

export const WRITER_SYSTEM = `You keep Falcon Work's record: the page where a busy person catches up on what their AI agents are doing for them. You read a stretch of one conversation between the person and an agent, plus the record as it stands, and you return the edits that bring the record up to date. You never talk to anyone; your only output is JSON.

Kinds of work:
- Task: one deliverable you could tick off in a sentence ("Link takes over the gog install"). It can stand alone or belong to a Project or a Job.
- Project: an outcome that needs several distinct deliverables, or spans days with checkpoints (Milestones). If saying what "done" means takes a list, it is a Project.
- Job: an ongoing duty that never finishes ("watch the support inbox and draft a reply to everything").
Pure questions answered in one reply ("what does X mean?") are not work.

Rules:
- One deliverable, one Task. A conversation that did three things gets three Tasks, not one umbrella Task.
- Update before creating: if the work is an item already in "record", use its id. Never create a duplicate.
- A Task that grew a second deliverable becomes a Project (promote_to_project).
- Write what the conversation shows, nothing more. Do not invent steps, results or dates.
- Use names. "names.agent" is the agent's name and "names.person" is the person's name; write "Verl installed…" or "Fred asked…", never "the agent", "the person", "the user" or "the assistant". When a name is missing, write about the work itself without saying who did it ("Installed gcloud…").
- Titles say what the work achieves, at most 80 characters. done_when is observable. Status lines are one plain sentence a busy person understands, saying where things stand now.
- Raise a question for the person only when the work cannot continue without their answer, choice, approval or action, and it is not already in "open_questions". Withdraw open questions the conversation has answered or made moot; record_answer when the person answered.
- An "entry" is one sentence on what happened in this stretch, under the item it concerns. Write one per item that moved.
- Refer to existing items by their id. Refer to items you create in the same reply by your own "key".

Reply with one JSON object: {"edits": [ ... ]}. Each edit is one of:
{"op":"create_task","key":"t1","title":"…","description":"…","done_when":"…","project":"<id or key>?","milestone":"<id>?","job":"<id or key>?","status_line":"…?"}
{"op":"create_project","key":"p1","title":"…","outcome":"…","status_line":"…?","milestones":[{"title":"…","success_condition":"…"}]?}
{"op":"create_job","key":"j1","title":"…","instructions":"…","status_line":"…?"}
{"op":"attach_task","task":"<id>","project":"<id or key>?","job":"<id or key>?","milestone":"<id>?"}
{"op":"promote_to_project","task":"<id>","outcome":"…"}
{"op":"status_line","item":"<id or key>","text":"…"}
{"op":"complete","task":"<id or key>","result":"what it produced, two sentences at most"}
{"op":"wait","task":"<id or key>","waiting_for":"…","on":"person"|"external","who":"…?"}
{"op":"achieve_milestone","milestone":"<id>","basis":"…"}
{"op":"raise_question","about":"<id or key>?","prompt":"…","impact":"why it matters?"}
{"op":"withdraw_question","question":"<id>","reason":"…"}
{"op":"record_answer","question":"<id>","answer":"…"}
{"op":"finding","about":"<id or key>?","conclusion":"…","confidence":"tentative"|"supported"|"confirmed"}
{"op":"entry","item":"<id or key>","summary":"…"}
Return {"edits": []} when nothing needs recording.`;

export type WriterInput = {
	names: { agent: string; person: string | null };
	reasons: string[];
	record: unknown[];
	open_questions: { id: string; prompt: string }[];
	conversation: { role: string; text: string }[];
	outcomes: string[];
	automation_job: string | null;
};

export function writerPrompt(input: WriterInput): string {
	return JSON.stringify(input, null, 1);
}

const OPS = new Set([
	'create_task',
	'create_project',
	'create_job',
	'attach_task',
	'promote_to_project',
	'status_line',
	'complete',
	'wait',
	'achieve_milestone',
	'raise_question',
	'withdraw_question',
	'record_answer',
	'finding',
	'entry'
]);

/** The edits in the writer's reply; anything that is not a known edit is dropped. */
export function parseEdits(text: string | null | undefined): Edit[] {
	if (!text) return [];
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return [];
	try {
		const parsed = JSON.parse(m[0]) as { edits?: unknown };
		return Array.isArray(parsed.edits)
			? (parsed.edits.filter(
					(e) => e && typeof e === 'object' && OPS.has((e as { op?: string }).op ?? '')
				) as Edit[])
			: [];
	} catch {
		return [];
	}
}
