-- NB-DASH-2026-005: Calendar T-5 notification dedupe table
-- idempotent: safe to re-run
--
-- 紀錄哪些 Google Calendar event 已經發過 T-5（5 分鐘前提醒）通知。
-- T-1（1 分鐘前自動加入）已經有 nb_calendar_auto_joined 處理。
-- 兩個 phase 分別獨立去重，避免 calendar-poller 重複觸發。

BEGIN;

CREATE TABLE IF NOT EXISTS nb_calendar_notified (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL,
  phase VARCHAR(10) NOT NULL CHECK (phase IN ('T-5', 'T-1')),
  meet_id VARCHAR(50),
  department_id INTEGER REFERENCES nb_departments(id) ON DELETE CASCADE,
  notified_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_nb_calendar_notified_event_phase
  ON nb_calendar_notified(event_id, phase);

COMMIT;
