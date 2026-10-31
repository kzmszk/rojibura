-- docs/prd.md Phase 2. Statements are idempotent so local development can apply them on startup.

-- #23: when each person first opened the site, logged in, entered, and got their own avatar or AI in.
-- One row per account; each time is written once.
CREATE TABLE IF NOT EXISTS onboarding (
	account_id TEXT PRIMARY KEY REFERENCES accounts (id),
	first_visit_at INTEGER,              -- the browser's first visit, if before login
	login_at INTEGER NOT NULL,           -- the account was created
	entered_at INTEGER,                  -- first entry to the city as themselves
	avatar_at INTEGER,                   -- their own avatar was ready (#25)
	ai_at INTEGER                        -- one of their AIs entered for the first time
);
CREATE INDEX IF NOT EXISTS onboarding_login ON onboarding (login_at);
INSERT OR IGNORE INTO onboarding (account_id, login_at) SELECT id, created_at FROM accounts;

-- #24: the trial LLM for browser AIs (host's Workers AI): calls per account and UTC day, and "*" for all.
CREATE TABLE IF NOT EXISTS trial_llm (
	account_id TEXT NOT NULL,
	day TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	neurons REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (account_id, day)
);
