import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { sql, type ActionItem, type Meeting } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";

export const meetingsRoute = new Hono<{ Variables: DeptVars }>();

meetingsRoute.use("/api/meetings", requireDept);
meetingsRoute.use("/api/meetings/*", requireDept);

meetingsRoute.get("/api/meetings", async (c) => {
  const deptId = getDeptId(c);
  // 用 AT TIME ZONE 'UTC' 把 naive timestamp 明確標成 UTC，避免被 postgres.js
  // 當成本機時間（Vexa 寫入的時間實際上是 UTC）
  const rows = await sql<Meeting[]>`
    SELECT id, title, meet_id, status,
           (start_time AT TIME ZONE 'UTC') AS start_time,
           (end_time AT TIME ZONE 'UTC') AS end_time,
           duration_minutes, summary
    FROM nb_meetings
    WHERE department_id = ${deptId}
    ORDER BY start_time DESC NULLS LAST, id DESC
  `;
  return c.json(rows);
});

meetingsRoute.get("/api/meetings/:id", async (c) => {
  const deptId = getDeptId(c);
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "無效的 meeting id" }, 400);
  }

  const meetings = await sql<Meeting[]>`
    SELECT id, department_id, vexa_meeting_id, title, meet_id, platform,
           status,
           (start_time AT TIME ZONE 'UTC') AS start_time,
           (end_time AT TIME ZONE 'UTC') AS end_time,
           duration_minutes, participants,
           summary, record_path, transcript_md_path, google_doc_id,
           (created_at AT TIME ZONE 'UTC') AS created_at
    FROM nb_meetings
    WHERE id = ${id} AND department_id = ${deptId}
    LIMIT 1
  `;
  const meeting = meetings[0];
  if (!meeting) {
    return c.json({ error: "會議不存在或無權限" }, 404);
  }

  const items = await sql<ActionItem[]>`
    SELECT id, meeting_id, department_id, code, description, assignee,
           priority, status, due_date, notes, created_at, updated_at
    FROM nb_action_items
    WHERE meeting_id = ${id} AND department_id = ${deptId}
    ORDER BY code
  `;

  return c.json({ meeting, action_items: items });
});

meetingsRoute.get("/api/meetings/:id/transcript", async (c) => {
  const deptId = getDeptId(c);
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "無效的 meeting id" }, 400);
  }

  const rows = await sql<{ transcript_md_path: string | null }[]>`
    SELECT transcript_md_path
    FROM nb_meetings
    WHERE id = ${id} AND department_id = ${deptId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return c.json({ error: "會議不存在或無權限" }, 404);
  }

  const rawPath = row.transcript_md_path;
  if (!rawPath) {
    return c.json({ error: "本場會議尚未儲存逐字稿" }, 404);
  }

  // 防呆：限制只能讀 RECORDS_DIR 底下的檔案
  // 資料庫裡的 transcript_md_path 有兩種格式：
  //   1. 絕對路徑：/home/.../records/部門/xxx.md
  //   2. 相對路徑：records/部門/xxx.md（相對於專案根目錄）
  const recordsDir = process.env.RECORDS_DIR
    ? resolve(process.env.RECORDS_DIR)
    : null;
  if (!recordsDir) {
    return c.json({ error: "伺服器未設定 RECORDS_DIR" }, 500);
  }
  // 推算專案根目錄（records 的 parent）
  const projectRoot = resolve(recordsDir, "..");

  let absPath: string;
  if (rawPath.startsWith("/")) {
    absPath = resolve(rawPath);
  } else {
    absPath = resolve(projectRoot, rawPath);
  }
  if (
    absPath !== recordsDir &&
    !absPath.startsWith(recordsDir + "/")
  ) {
    return c.json({ error: "逐字稿路徑不合法" }, 400);
  }

  try {
    const md = await readFile(absPath, "utf-8");
    return c.json({ markdown: md, path: absPath });
  } catch (err) {
    return c.json({ error: "無法讀取逐字稿檔案" }, 404);
  }
});
