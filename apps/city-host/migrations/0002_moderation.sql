-- docs/prd.md 3.6 / 4.2: personal mute and block, reports, moderation audit log.

CREATE TABLE IF NOT EXISTS relations (
	account_id TEXT NOT NULL,            -- who mutes or blocks
	target_id TEXT NOT NULL,             -- avatar ID (human or AI)
	kind TEXT NOT NULL,                  -- mute / block
	created_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, target_id, kind)
);
CREATE INDEX IF NOT EXISTS relations_target ON relations (target_id);

CREATE TABLE IF NOT EXISTS reports (
	id TEXT PRIMARY KEY,
	reporter_id TEXT NOT NULL,
	target_id TEXT NOT NULL,
	reason TEXT NOT NULL,                -- harassment / spam / inappropriate / other
	note TEXT NOT NULL DEFAULT '',
	excerpt_json TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL DEFAULT 'open', -- open / resolved
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_status ON reports (status, created_at);

CREATE TABLE IF NOT EXISTS mod_actions (
	id TEXT PRIMARY KEY,
	actor_id TEXT NOT NULL,
	action TEXT NOT NULL,                -- mute / kick / ban / suspend / resolve
	subject_id TEXT NOT NULL,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL
);
