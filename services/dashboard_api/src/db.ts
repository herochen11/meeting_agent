import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("環境變數 DATABASE_URL 未設定");
}

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  // postgres.js 預設會把 snake_case 轉成 camelCase 如有開啟 transform；保留原始欄位名稱
  transform: { undefined: null },
});

export async function ping(): Promise<boolean> {
  try {
    const rows = await sql`SELECT 1 AS ok`;
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export interface Department {
  id: number;
  name: string;
  slug: string;
  password_hash: string;
}

export interface Meeting {
  id: number;
  department_id: number | null;
  vexa_meeting_id: number | null;
  title: string;
  meet_id: string | null;
  platform: string | null;
  status: string | null;
  start_time: Date | null;
  end_time: Date | null;
  duration_minutes: number | null;
  participants: string[] | null;
  summary: string | null;
  record_path: string | null;
  transcript_md_path: string | null;
  google_doc_id: string | null;
  created_at: Date | null;
}

export interface ActionItem {
  id: number;
  meeting_id: number | null;
  department_id: number | null;
  code: string;
  description: string;
  assignee: string | null;
  priority: string | null;
  status: string | null;
  due_date: Date | null;
  notes: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}
