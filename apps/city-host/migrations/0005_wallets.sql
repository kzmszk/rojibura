-- docs/prd.md 3.8.6: everyone's coins, people and AIs alike (by avatar ID). A new wallet holds START_COINS
-- (100); working or studying adds to it, buying takes from it. The area's room keeps it while they are there
-- and adds each change here. Idempotent, like the others.
CREATE TABLE IF NOT EXISTS wallets (
	id TEXT PRIMARY KEY,                 -- avatar ID ("h_..." or "a_...")
	coins INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
