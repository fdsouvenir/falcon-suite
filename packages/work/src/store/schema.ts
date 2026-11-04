// Falcon Work 2.0 schema. Mirrors docs/work-spec.md §4.
// Ids are text. Times are ISO-8601 UTC text. Mutable objects carry an optimistic `version`.
// JSON columns hold arrays/objects that are always read and written whole.

/** 2.0 databases start at 100; anything below is a Work 5 database, set aside on first start (§8). */
export const SCHEMA_VERSION = 100;

/**
 * What the clerk keeps (spec §3, §4). Raw tool calls are never stored: a timeline entry holds a
 * turn's outcomes and one sentence, and points at the session transcript.
 */
export const RECORD_TABLES = `
CREATE TABLE timeline_entry (
	id TEXT PRIMARY KEY,
	subject_kind TEXT CHECK (subject_kind IN ('task','project','job')),
	subject_id TEXT,
	agent TEXT NOT NULL,
	session_key TEXT,
	run_id TEXT,
	at TEXT NOT NULL,
	outcomes TEXT NOT NULL CHECK (json_valid(outcomes)),
	summary TEXT,
	recorded_by TEXT NOT NULL CHECK (recorded_by IN ('work','agent','person')),
	UNIQUE (run_id, subject_id)
) STRICT;
CREATE INDEX timeline_subject ON timeline_entry(subject_id, at);
CREATE INDEX timeline_at ON timeline_entry(at);

-- Where an item's work happened: feeds "3 sessions" and the session chips.
CREATE TABLE item_session (
	item_id TEXT NOT NULL,
	item_kind TEXT NOT NULL CHECK (item_kind IN ('task','project','job')),
	session_key TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	PRIMARY KEY (item_id, session_key)
) STRICT;
CREATE INDEX item_session_key ON item_session(session_key);

-- The clerk's progress through each session's transcript.
CREATE TABLE clerk_checkpoint (
	session_key TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL,
	last_seq INTEGER NOT NULL,
	last_at TEXT,
	marked TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
) STRICT;

-- Which fields of which objects Work last wrote, so people's and agents' entries win (§3.5).
CREATE TABLE written_by (
	object_id TEXT NOT NULL,
	field TEXT NOT NULL,
	by TEXT NOT NULL CHECK (by IN ('work','agent','person')),
	at TEXT NOT NULL,
	PRIMARY KEY (object_id, field)
) STRICT;

-- Key/value facts about the store itself (catch-up progress, last visit).
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
`;

export const SCHEMA = `
CREATE TABLE job (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	instructions TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active','paused','retired')),
	agent TEXT,
	status_line TEXT,
	status_line_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;

-- The OpenClaw automations that run a Job; Work never schedules anything itself.
CREATE TABLE job_automation (
	job_id TEXT NOT NULL REFERENCES job(id),
	automation_id TEXT NOT NULL,
	name TEXT,
	PRIMARY KEY (job_id, automation_id)
) STRICT;
CREATE INDEX job_automation_id ON job_automation(automation_id);

CREATE TABLE project (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	outcome TEXT NOT NULL,
	agent TEXT,
	abandoned_at TEXT,
	status_line TEXT,
	status_line_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;

CREATE TABLE milestone (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES project(id),
	title TEXT NOT NULL,
	success_condition TEXT NOT NULL,
	position INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open','achieved')),
	achieved_at TEXT,
	basis TEXT,
	sources TEXT,
	version INTEGER NOT NULL,
	CHECK (status = 'open' OR (basis IS NOT NULL AND json_array_length(sources) >= 1))
) STRICT;

CREATE TABLE task (
	id TEXT PRIMARY KEY,
	project_id TEXT REFERENCES project(id),
	job_id TEXT REFERENCES job(id),
	milestone_id TEXT REFERENCES milestone(id),
	status TEXT NOT NULL CHECK (status IN ('open','ready','in_progress','waiting','completed','abandoned')),
	prior_status TEXT,
	agent TEXT,
	definition_rev INTEGER NOT NULL,
	waiting_for TEXT,
	waiting_on_kind TEXT CHECK (waiting_on_kind IN ('agent','person','work','external')),
	waiting_on_ref TEXT,
	resume_when TEXT,
	follow_up_at TEXT,
	accepted_result_id TEXT,
	status_line TEXT,
	status_line_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL,
	CHECK (project_id IS NULL OR job_id IS NULL),
	CHECK (milestone_id IS NULL OR project_id IS NOT NULL),
	CHECK (status <> 'in_progress' OR agent IS NOT NULL),
	CHECK (status <> 'waiting' OR (waiting_for IS NOT NULL AND waiting_on_kind IS NOT NULL AND resume_when IS NOT NULL)),
	CHECK (status <> 'completed' OR accepted_result_id IS NOT NULL)
) STRICT;

CREATE TABLE task_definition (
	task_id TEXT NOT NULL REFERENCES task(id),
	rev INTEGER NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	done_when TEXT NOT NULL,
	reason TEXT,
	author TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (task_id, rev),
	CHECK (rev = 1 OR reason IS NOT NULL)
) STRICT;

CREATE TABLE task_plan (
	task_id TEXT NOT NULL REFERENCES task(id),
	rev INTEGER NOT NULL,
	definition_rev INTEGER NOT NULL,
	content TEXT NOT NULL,
	author TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (task_id, rev)
) STRICT;

CREATE TABLE task_result (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES task(id),
	definition_rev INTEGER NOT NULL,
	content TEXT NOT NULL,
	sources TEXT NOT NULL CHECK (json_array_length(sources) >= 1),
	author TEXT NOT NULL,
	at TEXT NOT NULL
) STRICT;

${RECORD_TABLES}

CREATE TABLE question (
	id TEXT PRIMARY KEY,
	prompt TEXT NOT NULL,
	impact TEXT NOT NULL,
	answerable_by TEXT NOT NULL CHECK (json_array_length(answerable_by) >= 1),
	status TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')),
	hypothesis TEXT,
	hypothesis_by TEXT,
	withdrawn_reason TEXT,
	session_key TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;

CREATE TABLE answer (
	id TEXT PRIMARY KEY,
	question_id TEXT NOT NULL REFERENCES question(id),
	text TEXT NOT NULL,
	confidence TEXT NOT NULL CHECK (confidence IN ('tentative','supported','confirmed')),
	sources TEXT NOT NULL,
	accepted_hypothesis INTEGER NOT NULL,
	author TEXT NOT NULL,
	at TEXT NOT NULL
) STRICT;

CREATE TABLE decision (
	id TEXT PRIMARY KEY,
	prompt TEXT NOT NULL,
	options TEXT NOT NULL CHECK (json_array_length(options) >= 2),
	recommendation TEXT NOT NULL,
	deciders TEXT NOT NULL CHECK (json_array_length(deciders) >= 1),
	consequence_of_no_decision TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending','decided','deferred','withdrawn','superseded')),
	chosen_option TEXT,
	rationale TEXT,
	decided_by TEXT,
	deferred_until TEXT,
	superseded_by TEXT REFERENCES decision(id),
	closed_reason TEXT,
	session_key TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	version INTEGER NOT NULL
) STRICT;

CREATE TABLE finding (
	id TEXT PRIMARY KEY,
	conclusion TEXT NOT NULL,
	confidence TEXT NOT NULL CHECK (confidence IN ('tentative','supported','confirmed')),
	sources TEXT NOT NULL CHECK (json_array_length(sources) >= 1),
	status TEXT NOT NULL CHECK (status IN ('current','retracted','superseded')),
	superseded_by TEXT REFERENCES finding(id),
	closed_reason TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;

-- Closed relationship vocabulary: depends_on (Task → Task), targets (Question, Decision or
-- Finding → the item it is about).
CREATE TABLE link (
	kind TEXT NOT NULL CHECK (kind IN ('depends_on','targets')),
	source_kind TEXT NOT NULL,
	source_id TEXT NOT NULL,
	target_kind TEXT NOT NULL,
	target_id TEXT NOT NULL,
	PRIMARY KEY (kind, source_id, target_id)
) STRICT;
CREATE INDEX link_target ON link(kind, target_id);

CREATE TABLE event (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	command TEXT NOT NULL,
	object_kind TEXT NOT NULL,
	object_id TEXT NOT NULL,
	version INTEGER,
	detail TEXT
) STRICT;
CREATE INDEX event_object ON event(object_id, seq);
CREATE TRIGGER event_immutable_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER event_immutable_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'immutable'); END;

-- One row per idempotency key: a replay returns the stored outcome without re-applying.
CREATE TABLE receipt (
	key TEXT PRIMARY KEY,
	actor TEXT NOT NULL,
	request TEXT NOT NULL,
	outcome TEXT NOT NULL,
	at TEXT NOT NULL
) STRICT;
`;
