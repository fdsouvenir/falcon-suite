// Work 5 schema, version 1. Mirrors docs/work-spec.md.
// Ids are text. Times are ISO-8601 UTC text. Mutable objects carry an optimistic `version`.
// JSON columns hold arrays/objects that are always read and written whole.

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE objective (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	statement TEXT NOT NULL,
	rank INTEGER,
	status TEXT NOT NULL CHECK (status IN ('active','paused','achieved','retired')),
	autonomy TEXT NOT NULL CHECK (autonomy IN ('propose','act')),
	limits TEXT,
	owner TEXT NOT NULL,
	session_key TEXT,
	session_set_by TEXT,
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL,
	CHECK (autonomy = 'propose' OR limits IS NOT NULL),
	CHECK ((status = 'active') = (rank IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX objective_rank ON objective(rank) WHERE rank IS NOT NULL;

CREATE TABLE kpi (
	id TEXT PRIMARY KEY,
	objective_id TEXT NOT NULL REFERENCES objective(id),
	name TEXT NOT NULL,
	unit TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('up','down','hold')),
	target REAL NOT NULL,
	target_date TEXT,
	removed_at TEXT,
	version INTEGER NOT NULL
) STRICT;

CREATE TABLE kpi_reading (
	id TEXT PRIMARY KEY,
	kpi_id TEXT NOT NULL REFERENCES kpi(id),
	value REAL NOT NULL,
	at TEXT NOT NULL,
	source TEXT NOT NULL,
	recorded_by TEXT NOT NULL
) STRICT;

CREATE TABLE review (
	id TEXT PRIMARY KEY,
	objective_id TEXT NOT NULL REFERENCES objective(id),
	author TEXT NOT NULL,
	at TEXT NOT NULL,
	moved TEXT NOT NULL,
	stalled TEXT NOT NULL,
	proposed TEXT,
	sources TEXT NOT NULL CHECK (json_array_length(sources) >= 1)
) STRICT;

CREATE TABLE area (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active','retired')),
	accountable_human TEXT NOT NULL,
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL
) STRICT;

CREATE TABLE project (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	outcome TEXT NOT NULL,
	area_id TEXT NOT NULL REFERENCES area(id),
	accountable_human TEXT NOT NULL,
	abandoned_at TEXT,
	session_key TEXT,
	session_set_by TEXT,
	created_at TEXT NOT NULL,
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
	area_id TEXT REFERENCES area(id),
	project_id TEXT REFERENCES project(id),
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
	session_key TEXT,
	session_set_by TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL,
	CHECK ((area_id IS NULL) <> (project_id IS NULL)),
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

CREATE TABLE activity (
	id TEXT PRIMARY KEY,
	task_id TEXT REFERENCES task(id),
	agent TEXT NOT NULL,
	session_key TEXT,
	at TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('command','file','message','commit','release','config','api','session')),
	summary TEXT NOT NULL,
	ref TEXT
) STRICT;
CREATE INDEX activity_task ON activity(task_id, at);

CREATE TABLE question (
	id TEXT PRIMARY KEY,
	prompt TEXT NOT NULL,
	impact TEXT NOT NULL,
	answerable_by TEXT NOT NULL CHECK (json_array_length(answerable_by) >= 1),
	status TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')),
	hypothesis TEXT,
	hypothesis_by TEXT,
	withdrawn_reason TEXT,
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

CREATE TABLE ask (
	id TEXT PRIMARY KEY,
	subject_kind TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	addressed_to TEXT NOT NULL,
	prompt TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending','answered','dismissed')),
	session_key TEXT,
	session_set_by TEXT,
	dismissed_reason TEXT,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	version INTEGER NOT NULL
) STRICT;
CREATE INDEX ask_open ON ask(addressed_to, status);

-- Closed relationship vocabulary (spec §2): serves, depends_on, targets.
CREATE TABLE link (
	kind TEXT NOT NULL CHECK (kind IN ('serves','depends_on','targets')),
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
