-- NB-DASH-2026-003: 本地錄音支援
-- 加 source 欄位區分會議來源（vexa-bot vs local-recording）
-- idempotent：可重複執行

BEGIN;

ALTER TABLE nb_meetings
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'vexa-bot';

CREATE INDEX IF NOT EXISTS idx_nb_meetings_source
  ON nb_meetings(department_id, source);

COMMIT;
