-- Falcon Work 5 — draft schema. Mirrors docs/work-spec.md; not yet an implementation.
-- Ids are text. Times are ISO-8601 UTC text. Mutable objects carry an optimistic `version`.
PRAGMA foreign_keys = ON;

CREATE TABLE objective (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	statement TEXT NOT NULL,
	rank INTEGER,                                -- unique among active; NULL when not active
	status TEXT NOT NULL CHECK (status IN ('active','paused','achieved','retired')),
	autonomy TEXT NOT NULL DEFAULT 'propose' CHECK (autonomy IN ('propose','act')),
	limits TEXT,
	owner TEXT NOT NULL,
	session_key TEXT,                            -- discussion session (spec §9); NULL = none
	session_linked_by TEXT,                      -- agent or person who set the current session
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	CHECK (autonomy = 'propose' OR limits IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX objective_rank ON objective(rank) WHERE status = 'active';

CREATE TABLE kpi (
	id TEXT PRIMARY KEY,
	objective_id TEXT NOT NULL REFERENCES objective(id),
	name TEXT NOT NULL,
	unit TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('up','down','hold')),
	target REAL NOT NULL,
	target_date TEXT
) STRICT;

CREATE TABLE kpi_reading (
	id TEXT PRIMARY KEY,
	kpi_id TEXT NOT NULL REFERENCES kpi(id),
	value REAL NOT NULL,
	at TEXT NOT NULL,
	source TEXT NOT NULL
) STRICT;

CREATE TABLE objective_review (
	id TEXT PRIMARY KEY,
	objective_id TEXT NOT NULL REFERENCES objective(id),
	author TEXT NOT NULL,
	at TEXT NOT NULL,
	moved TEXT NOT NULL,
	stalled TEXT NOT NULL,
	proposed TEXT,
	sources TEXT NOT NULL                        -- JSON array of {kind, ref, label}
) STRICT;

CREATE TABLE area (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active','retired')),
	accountable_human TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE project (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	outcome TEXT NOT NULL,
	area_id TEXT NOT NULL REFERENCES area(id),
	accountable_human TEXT NOT NULL,
	abandoned_at TEXT,                           -- status is derived; only abandonment is stored
	session_key TEXT,                            -- discussion session (spec §9); NULL = none
	session_linked_by TEXT,                      -- agent or person who set the current session
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE milestone (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES project(id),
	title TEXT NOT NULL,
	success_condition TEXT NOT NULL,
	ord INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open','achieved')),
	achieved_at TEXT,
	basis TEXT,
	sources TEXT,                                -- JSON array, required when achieved
	version INTEGER NOT NULL DEFAULT 1,
	CHECK (status = 'open' OR (basis IS NOT NULL AND sources IS NOT NULL))
) STRICT;

CREATE TABLE task (
	id TEXT PRIMARY KEY,
	area_id TEXT REFERENCES area(id),            -- exactly one of area_id / project_id
	project_id TEXT REFERENCES project(id),
	milestone_id TEXT REFERENCES milestone(id),
	status TEXT NOT NULL CHECK (status IN ('open','ready','in_progress','waiting','completed','abandoned')),
	agent TEXT,                                  -- the one accountable agent
	definition_rev INTEGER NOT NULL,
	waiting_for TEXT,
	waiting_on_kind TEXT CHECK (waiting_on_kind IN ('agent','person','work','external')),
	waiting_on_ref TEXT,
	resume_when TEXT,
	follow_up_at TEXT,
	session_key TEXT,                            -- discussion session (spec §9); NULL = none
	session_linked_by TEXT,                      -- agent or person who set the current session
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	CHECK ((area_id IS NULL) <> (project_id IS NULL)),
	CHECK (status <> 'in_progress' OR agent IS NOT NULL),
	CHECK (status <> 'waiting' OR (waiting_for IS NOT NULL AND waiting_on_kind IS NOT NULL AND resume_when IS NOT NULL))
) STRICT;

CREATE TABLE task_definition (
	task_id TEXT NOT NULL REFERENCES task(id),
	rev INTEGER NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	done_when TEXT NOT NULL,
	reason TEXT,                                 -- required from rev 2
	author TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (task_id, rev)
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
	accepted INTEGER NOT NULL DEFAULT 0,
	author TEXT NOT NULL,
	at TEXT NOT NULL
) STRICT;

-- What the agent actually did, captured by hooks (spec §10). task_id NULL = untracked activity.
CREATE TABLE activity (
	id TEXT PRIMARY KEY,
	task_id TEXT REFERENCES task(id),
	agent TEXT NOT NULL,
	at TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('command','file','message','commit','release','config','api','session')),
	summary TEXT NOT NULL,
	ref TEXT
) STRICT;

CREATE TABLE question (
	id TEXT PRIMARY KEY,
	prompt TEXT NOT NULL,
	impact TEXT NOT NULL,
	answerable_by TEXT NOT NULL,                 -- JSON array
	status TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')),
	answer TEXT,
	confidence TEXT CHECK (confidence IN ('tentative','supported','confirmed')),
	answer_sources TEXT,
	hypothesis TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE decision (
	id TEXT PRIMARY KEY,
	prompt TEXT NOT NULL,
	options TEXT NOT NULL CHECK (json_array_length(options) >= 2),
	recommendation TEXT NOT NULL,                -- JSON {option, rationale}
	deciders TEXT NOT NULL,                      -- JSON array
	consequence_of_no_decision TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending','decided','deferred','withdrawn','superseded')),
	chosen_option TEXT,
	rationale TEXT,
	decided_by TEXT,
	deferred_until TEXT,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE finding (
	id TEXT PRIMARY KEY,
	conclusion TEXT NOT NULL,
	confidence TEXT NOT NULL CHECK (confidence IN ('tentative','supported','confirmed')),
	sources TEXT NOT NULL CHECK (json_array_length(sources) >= 1),
	status TEXT NOT NULL CHECK (status IN ('current','retracted','superseded')),
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE ask (
	id TEXT PRIMARY KEY,
	subject_kind TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	addressed_to TEXT NOT NULL,
	session_key TEXT,                            -- discussion session (spec §9); NULL = none
	session_linked_by TEXT,                      -- agent or person who set the current session
	prompt TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending','answered','dismissed')),
	created_at TEXT NOT NULL,
	resolved_at TEXT
) STRICT;

-- Closed relationship vocabulary (spec §2).
CREATE TABLE link (
	kind TEXT NOT NULL CHECK (kind IN ('serves','depends_on','targets','placement')),
	source_kind TEXT NOT NULL,
	source_id TEXT NOT NULL,
	target_kind TEXT NOT NULL,
	target_id TEXT NOT NULL,
	PRIMARY KEY (kind, source_id, target_id)
) STRICT;

CREATE TABLE event (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	command TEXT NOT NULL,
	object_kind TEXT NOT NULL,
	object_id TEXT NOT NULL,
	detail TEXT
) STRICT;
