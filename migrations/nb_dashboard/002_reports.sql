-- NB-DASH-2026-002 Phase B: Reports (週報 / 月報) skeleton
-- idempotent: safe to re-run

BEGIN;

CREATE TABLE IF NOT EXISTS nb_reports (
    id SERIAL PRIMARY KEY,
    department_id INTEGER REFERENCES nb_departments(id) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('weekly', 'monthly')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    title VARCHAR(500) NOT NULL,
    content_md TEXT NOT NULL,
    stats_json JSONB,  -- 可選：聚合的數字統計
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nb_reports_dept_type_period
  ON nb_reports(department_id, type, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_nb_reports_created
  ON nb_reports(created_at DESC);

COMMIT;
