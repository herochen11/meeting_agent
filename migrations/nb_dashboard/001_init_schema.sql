-- NB-DASH-2026-001 Phase A: Dashboard initial schema
-- idempotent: safe to re-run

BEGIN;

CREATE TABLE IF NOT EXISTS nb_departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    chat_id VARCHAR(50),
    sheet_id VARCHAR(100),
    drive_folder_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_meetings (
    id SERIAL PRIMARY KEY,
    department_id INTEGER REFERENCES nb_departments(id),
    vexa_meeting_id INTEGER,
    title VARCHAR(500) NOT NULL,
    meet_id VARCHAR(100),
    platform VARCHAR(50) DEFAULT 'Google Meet',
    status VARCHAR(20) DEFAULT 'completed',
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    duration_minutes INTEGER,
    participants TEXT[],
    summary TEXT,
    record_path VARCHAR(500),
    transcript_md_path VARCHAR(500),
    google_doc_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_action_items (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER REFERENCES nb_meetings(id),
    department_id INTEGER REFERENCES nb_departments(id),
    code VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    assignee VARCHAR(100),
    priority VARCHAR(10) DEFAULT '中',
    status VARCHAR(20) DEFAULT '未開始',
    due_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_admin (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nb_meetings_department_id ON nb_meetings(department_id);
CREATE INDEX IF NOT EXISTS idx_nb_meetings_meet_id ON nb_meetings(meet_id);
CREATE INDEX IF NOT EXISTS idx_nb_action_items_meeting_id ON nb_action_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_nb_action_items_code ON nb_action_items(code);
CREATE INDEX IF NOT EXISTS idx_nb_action_items_dept_status ON nb_action_items(department_id, status);

COMMIT;
