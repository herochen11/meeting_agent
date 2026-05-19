import { Hono } from "hono";
import { sql } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";

export const reportsRoute = new Hono<{ Variables: DeptVars }>();

reportsRoute.use("/api/reports", requireDept);
reportsRoute.use("/api/reports/*", requireDept);

export interface ReportListRow {
  id: number;
  type: "weekly" | "monthly";
  period_start: string; // YYYY-MM-DD
  period_end: string;
  title: string;
  created_at: Date | null;
}

export interface ReportDetailRow extends ReportListRow {
  department_id: number;
  content_md: string;
  stats_json: Record<string, unknown> | null;
}

/**
 * GET /api/reports
 * 列出本部門已產生的報表（週報 / 月報），最近 50 筆。
 */
reportsRoute.get("/api/reports", async (c) => {
  const deptId = getDeptId(c);
  // postgres.js 對 naive timestamp 的時區處理有怪癖，先 AT TIME ZONE 'UTC'
  // 把它明確標成 UTC，這樣前端 new Date(iso + 'Z') 才會解析正確。
  const rows = await sql<ReportListRow[]>`
    SELECT id, type,
           TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start,
           TO_CHAR(period_end,   'YYYY-MM-DD') AS period_end,
           title,
           (created_at AT TIME ZONE 'UTC') AS created_at
    FROM nb_reports
    WHERE department_id = ${deptId}
    ORDER BY period_start DESC, id DESC
    LIMIT 50
  `;
  return c.json(rows);
});

/**
 * GET /api/reports/:id
 * 取得單一報表詳情（含 markdown 內容）。
 * 部門隔離：必須 department_id = 當前 session 的 dept。
 */
reportsRoute.get("/api/reports/:id", async (c) => {
  const deptId = getDeptId(c);
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "無效的 report id" }, 400);
  }

  const rows = await sql<ReportDetailRow[]>`
    SELECT id, department_id, type,
           TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start,
           TO_CHAR(period_end,   'YYYY-MM-DD') AS period_end,
           title, content_md, stats_json,
           (created_at AT TIME ZONE 'UTC') AS created_at
    FROM nb_reports
    WHERE id = ${id} AND department_id = ${deptId}
    LIMIT 1
  `;
  const report = rows[0];
  if (!report) {
    return c.json({ error: "報表不存在或無權限" }, 404);
  }
  return c.json(report);
});
