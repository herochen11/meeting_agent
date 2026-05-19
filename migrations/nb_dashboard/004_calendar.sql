-- NB-DASH-2026-004: Google Calendar OAuth + 自動加入記錄
-- idempotent: safe to re-run

BEGIN;

CREATE TABLE IF NOT EXISTS nb_calendar_accounts (
  id SERIAL PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES nb_departments(id) ON DELETE CASCADE,
  google_email VARCHAR(255) NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expires_at TIMESTAMP,
  scopes TEXT[],
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (department_id, google_email)
);

CREATE INDEX IF NOT EXISTS idx_nb_calendar_accounts_dept
  ON nb_calendar_accounts(department_id) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS nb_calendar_auto_joined (
  event_id VARCHAR(255) PRIMARY KEY,
  meet_id VARCHAR(50) NOT NULL,
  department_id INTEGER NOT NULL REFERENCES nb_departments(id) ON DELETE CASCADE,
  google_email VARCHAR(255),
  joined_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nb_calendar_auto_joined_meet
  ON nb_calendar_auto_joined(meet_id);

COMMIT;
