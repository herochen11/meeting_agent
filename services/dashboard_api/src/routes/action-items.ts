import { Hono } from "hono";
import ExcelJS from "exceljs";
import { sql, type ActionItem } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";

export const actionItemsRoute = new Hono<{ Variables: DeptVars }>();

actionItemsRoute.use("/api/action-items", requireDept);
actionItemsRoute.use("/api/action-items/*", requireDept);

const ALLOWED_STATUS = new Set(["未開始", "進行中", "已完成"]);
const ALLOWED_PRIORITY = new Set(["高", "中", "低"]);

/** YYYY-MM-DD for a Date-or-null */
function fmtDate(d: Date | string | null): string {
  if (!d) return "";
  if (typeof d === "string") return d.length >= 10 ? d.slice(0, 10) : d;
  // d is Date — use UTC pieces to avoid TZ drift (DB column is DATE not TIMESTAMPTZ)
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 查該部門名稱（用於 Excel 匯出檔名） */
async function getDeptName(deptId: number): Promise<{ name: string }> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM nb_departments WHERE id = ${deptId} LIMIT 1
  `;
  return rows[0] ?? { name: "" };
}

/**
 * 算出某部門在某天（MMDD）的下一個 code（MMDD_N）。
 * 找出該部門中所有 code 開頭為 `MMDD_` 的最大 N，回 +1。
 */
async function nextCode(deptId: number, dateStr: string): Promise<string> {
  // dateStr 格式：MMDD
  const prefix = `${dateStr}_`;
  const rows = await sql<{ code: string }[]>`
    SELECT code FROM nb_action_items
    WHERE department_id = ${deptId} AND code LIKE ${prefix + "%"}
  `;
  let maxN = 0;
  for (const r of rows) {
    const m = /^(\d{4})_(\d+)$/.exec(r.code);
    if (m && m[1] === dateStr) {
      const n = Number.parseInt(m[2]!, 10);
      if (Number.isInteger(n) && n > maxN) maxN = n;
    }
  }
  return `${dateStr}_${maxN + 1}`;
}

function todayMMDD(): string {
  // 用伺服器時區（UTC+8 assumed by專案規範）。改用本地日期。
  const d = new Date();
  // 為了與專案 MMDD 規則保持一致（會議日期用本地），這裡用 Asia/Taipei 偏移
  const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const mm = String(tw.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(tw.getUTCDate()).padStart(2, "0");
  return `${mm}${dd}`;
}

actionItemsRoute.get("/api/action-items", async (c) => {
  const deptId = getDeptId(c);
  const rows = await sql<ActionItem[]>`
    SELECT id, meeting_id, department_id, code, description, assignee,
           priority, status, due_date, notes, created_at, updated_at
    FROM nb_action_items
    WHERE department_id = ${deptId}
    ORDER BY code
  `;
  return c.json(rows);
});

type ExportRow = Pick<
  ActionItem,
  "code" | "description" | "assignee" | "priority" | "status" | "due_date" | "notes"
>;

// ── 樣式常數 ──（給 populateSheet 共用）
const HEADER_FILL = {
  type: "pattern" as const,
  pattern: "solid" as const,
  fgColor: { argb: "FFDBEAFE" }, // 淺藍
};
const OWNER_FILL = {
  type: "pattern" as const,
  pattern: "solid" as const,
  fgColor: { argb: "FFFEF3C7" }, // 橘黃
};
const IN_PROGRESS_FILL = {
  type: "pattern" as const,
  pattern: "solid" as const,
  fgColor: { argb: "FFFFFBEB" }, // 淺黃
};
const WHITE_FILL = {
  type: "pattern" as const,
  pattern: "solid" as const,
  fgColor: { argb: "FFFFFFFF" }, // 白
};
const COMPLETED_FILL = {
  type: "pattern" as const,
  pattern: "solid" as const,
  fgColor: { argb: "FFE5E7EB" }, // 灰
};
const CELL_BORDER = {
  top: { style: "thin" as const, color: { argb: "FFE5E7EB" } },
  left: { style: "thin" as const, color: { argb: "FFE5E7EB" } },
  bottom: { style: "thin" as const, color: { argb: "FFE5E7EB" } },
  right: { style: "thin" as const, color: { argb: "FFE5E7EB" } },
};

const COLUMN_WIDTHS = [12, 60, 12, 8, 8, 14, 30] as const;

/**
 * 將 rows 寫入指定 worksheet（含表頭、樣式、owner header row、配色）。
 * 由 export.xlsx handler 共用（單分頁 / multi_sheet 模式都呼叫這個）。
 */
function populateSheet(
  ws: ExcelJS.Worksheet,
  rows: ExportRow[],
): void {
  // 用 ws.columns 設定 keys + widths（在寫入 header values 之前，這樣 widths
  // 一定會被 ExcelJS 序列化）。Header values 會在下方手動覆寫並套樣式。
  ws.columns = [
    { key: "code", width: COLUMN_WIDTHS[0] },
    { key: "description", width: COLUMN_WIDTHS[1] },
    { key: "assignee", width: COLUMN_WIDTHS[2] },
    { key: "priority", width: COLUMN_WIDTHS[3] },
    { key: "status", width: COLUMN_WIDTHS[4] },
    { key: "due_date", width: COLUMN_WIDTHS[5] },
    { key: "notes", width: COLUMN_WIDTHS[6] },
  ];

  // ── 表頭（row 1，7 欄）──
  const headers = [
    "編號",
    "任務描述",
    "負責人",
    "優先級",
    "狀態",
    "預計完成時間",
    "備註",
  ];
  const headerRow = ws.getRow(1);
  headers.forEach((h, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.alignment = {
      horizontal: "left",
      vertical: "middle",
      wrapText: true,
    };
    cell.border = CELL_BORDER;
  });
  headerRow.height = 28;
  headerRow.commit();

  // ── 依負責人分組寫入 ──
  let currentOwner: string | null = null;
  let rowNum = 2;
  for (const r of rows) {
    const ownerName = r.assignee ?? "未指派";
    if (ownerName !== currentOwner) {
      // 插入 owner separator row（跨 A:G 合併）
      const ownerRow = ws.getRow(rowNum);
      ownerRow.getCell(1).value = `▾ ${ownerName}`;
      for (let c = 1; c <= 7; c++) {
        const cell = ownerRow.getCell(c);
        cell.fill = OWNER_FILL;
        cell.border = CELL_BORDER;
      }
      ownerRow.getCell(1).font = { bold: true, size: 12 };
      ws.mergeCells(rowNum, 1, rowNum, 7);
      ownerRow.commit();
      rowNum += 1;
      currentOwner = ownerName;
    }

    const priority = r.priority ?? "中";
    const status = r.status ?? "未開始";
    const values = [
      r.code ?? "",
      r.description ?? "",
      ownerName,
      priority,
      status,
      fmtDate(r.due_date),
      r.notes ?? "",
    ];
    const dataRow = ws.getRow(rowNum);
    values.forEach((val, idx) => {
      const cell = dataRow.getCell(idx + 1);
      cell.value = val;
      cell.alignment = {
        horizontal: "left",
        vertical: "top",
        wrapText: true,
      };
      cell.border = CELL_BORDER;
      // 預設按 status 配色
      if (status === "進行中") {
        cell.fill = IN_PROGRESS_FILL;
      } else if (status === "已完成") {
        cell.fill = COMPLETED_FILL;
      } else {
        cell.fill = WHITE_FILL;
      }
    });
    // 已完成 row：描述加刪除線
    if (status === "已完成") {
      dataRow.getCell(2).font = {
        strike: true,
        color: { argb: "FF9CA3AF" },
      };
    }
    dataRow.commit();
    rowNum += 1;
  }

  // 再次強制設定 column widths（避免 ExcelJS 在寫入 header 文字後自動推算覆寫）
  COLUMN_WIDTHS.forEach((w, idx) => {
    ws.getColumn(idx + 1).width = w;
  });
}

/**
 * Excel 匯出：GET /api/action-items/export.xlsx
 *
 * 兩種模式：
 *
 * 【單分頁模式】（沒帶 multi_sheet）
 *   - 一個 worksheet（`未完成 Action Items`），預設只匯出未完成（未開始+進行中）
 *   - 可選 query：
 *     - ?status=（未開始/進行中/已完成）  顯式指定狀態時，不再套用「排除已完成」
 *     - ?assignee=（部分比對）
 *     - ?includeCompleted=true            預設只匯出未開始+進行中；加此參數才包含已完成
 *
 * 【multi_sheet 模式】（?multi_sheet=true）
 *   - 兩個 worksheet：
 *     1. `所有未完成`（status IN ('未開始','進行中')）
 *     2. `進行中`（status='進行中'）
 *   - 兩個分頁都依 assignee + code 排序
 *   - status / assignee / includeCompleted query 都被忽略（schema 固定）
 *
 * 共用規格：
 *   - 表頭 7 欄：編號 / 任務描述 / 負責人 / 優先級 / 狀態 / 預計完成時間 / 備註
 *   - Freeze A2、表頭粗體 + 淺藍底 #DBEAFE
 *   - 依 assignee ASC 分組（無負責人放最後）；每組前插入跨欄合併的 owner header row
 *     （▾ owner_name，橘黃底 #FEF3C7，bold 12pt）
 *   - 進行中 → 淺黃 #FFFBEB；未開始 → 白；已完成 → 灰 + 描述刪除線
 *   - Column widths：12 / 60 / 12 / 8 / 8 / 14 / 30
 *
 * 回傳 binary xlsx，附 Content-Disposition。
 */
actionItemsRoute.get("/api/action-items/export.xlsx", async (c) => {
  const deptId = getDeptId(c);

  const multiSheetRaw = c.req.query("multi_sheet");
  const multiSheet = multiSheetRaw === "true" || multiSheetRaw === "1";

  // 部門資訊（拿 name 做檔名）
  const dept = await getDeptName(deptId);

  const wb = new ExcelJS.Workbook();
  wb.creator = "NoirsBoxes Dashboard";
  wb.created = new Date();

  const today = fmtDate(new Date());
  const deptName = dept.name || `dept-${deptId}`;
  let fnameAscii: string;
  let fnameUtf8: string;

  if (multiSheet) {
    // 兩分頁：所有未完成 + 進行中
    const openRows = await sql<ExportRow[]>`
      SELECT code, description, assignee, priority, status, due_date, notes
      FROM nb_action_items
      WHERE department_id = ${deptId}
        AND status IN ('未開始', '進行中')
      ORDER BY COALESCE(assignee, 'zzz'),
               CASE WHEN status = '進行中' THEN 0 ELSE 1 END,
               code
    `;
    const inProgressRows = await sql<ExportRow[]>`
      SELECT code, description, assignee, priority, status, due_date, notes
      FROM nb_action_items
      WHERE department_id = ${deptId}
        AND status = '進行中'
      ORDER BY COALESCE(assignee, 'zzz'),
               CASE WHEN status = '進行中' THEN 0 ELSE 1 END,
               code
    `;

    const wsAll = wb.addWorksheet("所有未完成", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    populateSheet(wsAll, openRows);

    const wsInProgress = wb.addWorksheet("進行中", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    populateSheet(wsInProgress, inProgressRows);

    fnameAscii = `Action-Items-${deptId}-open+in-progress-${today}.xlsx`;
    fnameUtf8 = encodeURIComponent(
      `Action-Items-${deptName}-未完成+進行中-${today}.xlsx`,
    );
  } else {
    // 單分頁：沿用既有 filter 行為
    const statusFilter = c.req.query("status");
    const assigneeFilter = c.req.query("assignee");
    const includeCompletedRaw = c.req.query("includeCompleted");
    const includeCompleted =
      includeCompletedRaw === "true" || includeCompletedRaw === "1";

    if (statusFilter && !ALLOWED_STATUS.has(statusFilter)) {
      return c.json({ error: "status 僅允許 未開始 / 進行中 / 已完成" }, 400);
    }

    // 若顯式指定 status，則不套用「排除已完成」（讓使用者能單獨拉已完成）
    const excludeCompleted = !statusFilter && !includeCompleted;

    // 撈該部門資料；ORDER BY 依 assignee ASC（無負責人放最後）+ code
    let rows: ExportRow[];
    if (statusFilter && assigneeFilter) {
      rows = await sql<ExportRow[]>`
        SELECT code, description, assignee, priority, status, due_date, notes
        FROM nb_action_items
        WHERE department_id = ${deptId}
          AND status = ${statusFilter}
          AND assignee ILIKE ${"%" + assigneeFilter + "%"}
        ORDER BY COALESCE(assignee, 'zzz'),
               CASE WHEN status = '進行中' THEN 0 ELSE 1 END,
               code
      `;
    } else if (statusFilter) {
      rows = await sql<ExportRow[]>`
        SELECT code, description, assignee, priority, status, due_date, notes
        FROM nb_action_items
        WHERE department_id = ${deptId}
          AND status = ${statusFilter}
        ORDER BY COALESCE(assignee, 'zzz'),
               CASE WHEN status = '進行中' THEN 0 ELSE 1 END,
               code
      `;
    } else if (assigneeFilter) {
      rows = await sql<ExportRow[]>`
        SELECT code, description, assignee, priority, status, due_date, notes
        FROM nb_action_items
        WHERE department_id = ${deptId}
          AND assignee ILIKE ${"%" + assigneeFilter + "%"}
          AND (${!excludeCompleted}::bool OR status != '已完成')
        ORDER BY COALESCE(assignee, 'zzz'),
               CASE WHEN status = '進行中' THEN 0 ELSE 1 END,
               code
      `;
    } else {
      rows = await sql<ExportRow[]>`
        SELECT code, description, assignee, priority, status, due_date, notes
        FROM nb_action_items
        WHERE department_id = ${deptId}
          AND (${!excludeCompleted}::bool OR status != '已完成')
        ORDER BY COALESCE(assignee, 'zzz'),
               CASE WHEN status = '進行中' THEN 0 ELSE 1 END,
               code
      `;
    }

    const ws = wb.addWorksheet("未完成 Action Items", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    populateSheet(ws, rows);

    const scopeLabel = excludeCompleted ? "未完成" : "完整";
    fnameAscii = `Action-Items-${deptId}-${scopeLabel === "未完成" ? "open" : "all"}-${today}.xlsx`;
    fnameUtf8 = encodeURIComponent(
      `Action-Items-${deptName}-${scopeLabel}-${today}.xlsx`,
    );
  }

  const buffer = await wb.xlsx.writeBuffer();

  c.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  c.header(
    "Content-Disposition",
    `attachment; filename="${fnameAscii}"; filename*=UTF-8''${fnameUtf8}`,
  );
  c.header("Cache-Control", "no-store");

  return c.body(buffer as ArrayBuffer);
});

interface CreateBody {
  description?: unknown;
  assignee?: unknown;
  priority?: unknown;
  due_date?: unknown;
  notes?: unknown;
  meeting_id?: unknown;
  code?: unknown;
}

actionItemsRoute.post("/api/action-items", async (c) => {
  const deptId = getDeptId(c);

  let body: CreateBody;
  try {
    body = (await c.req.json()) as CreateBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 body" }, 400);
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return c.json({ error: "description 為必填" }, 400);
  }

  const assignee =
    typeof body.assignee === "string" && body.assignee.trim()
      ? body.assignee.trim()
      : null;

  const priority =
    typeof body.priority === "string" && body.priority.trim()
      ? body.priority.trim()
      : "中";
  if (!ALLOWED_PRIORITY.has(priority)) {
    return c.json({ error: "priority 僅允許 高 / 中 / 低" }, 400);
  }

  const dueDate =
    typeof body.due_date === "string" && body.due_date.trim()
      ? body.due_date.trim()
      : null;
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return c.json({ error: "due_date 必須為 YYYY-MM-DD 格式" }, 400);
  }

  const notes =
    typeof body.notes === "string" && body.notes.trim()
      ? body.notes.trim()
      : null;

  let meetingId: number | null = null;
  if (typeof body.meeting_id === "number" && Number.isInteger(body.meeting_id)) {
    meetingId = body.meeting_id;
  } else if (typeof body.meeting_id === "string" && body.meeting_id.trim()) {
    const parsed = Number.parseInt(body.meeting_id, 10);
    if (Number.isInteger(parsed)) meetingId = parsed;
  }
  // 防跨部門引用會議
  if (meetingId !== null) {
    const check = await sql<{ id: number }[]>`
      SELECT id FROM nb_meetings
      WHERE id = ${meetingId} AND department_id = ${deptId}
      LIMIT 1
    `;
    if (check.length === 0) {
      return c.json({ error: "指定的會議不存在或無權限" }, 400);
    }
  }

  let code =
    typeof body.code === "string" && body.code.trim() ? body.code.trim() : "";
  if (code) {
    if (!/^\d{4}_\d+$/.test(code)) {
      return c.json({ error: "code 必須為 MMDD_N 格式" }, 400);
    }
  } else {
    code = await nextCode(deptId, todayMMDD());
  }

  const inserted = await sql<ActionItem[]>`
    INSERT INTO nb_action_items
      (meeting_id, department_id, code, description, assignee, priority,
       status, due_date, notes)
    VALUES
      (${meetingId}, ${deptId}, ${code}, ${description}, ${assignee}, ${priority},
       '未開始', ${dueDate}, ${notes})
    RETURNING id, meeting_id, department_id, code, description, assignee,
              priority, status, due_date, notes, created_at, updated_at
  `;
  const row = inserted[0]!;

  // 自 2026-05-19 起不再寫入 Google Sheets — DB 為唯一資料來源
  return c.json(row, 201);
});

interface UpdateBody {
  description?: unknown;
  assignee?: unknown;
  priority?: unknown;
  status?: unknown;
  due_date?: unknown;
  notes?: unknown;
}

actionItemsRoute.patch("/api/action-items/:id", async (c) => {
  const deptId = getDeptId(c);
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "無效的 id" }, 400);
  }

  let body: UpdateBody;
  try {
    body = (await c.req.json()) as UpdateBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 body" }, 400);
  }

  // 先確認該 item 屬於 caller 部門
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM nb_action_items
    WHERE id = ${id} AND department_id = ${deptId}
    LIMIT 1
  `;
  if (existing.length === 0) {
    return c.json({ error: "Action Item 不存在或無權限" }, 404);
  }

  const updates: Record<string, string | null> = {};

  if (body.description !== undefined) {
    if (typeof body.description !== "string" || !body.description.trim()) {
      return c.json({ error: "description 不可為空" }, 400);
    }
    updates.description = body.description.trim();
  }
  if (body.assignee !== undefined) {
    if (body.assignee === null) {
      updates.assignee = null;
    } else if (typeof body.assignee !== "string") {
      return c.json({ error: "assignee 必須為字串" }, 400);
    } else {
      const trimmed = body.assignee.trim();
      updates.assignee = trimmed ? trimmed : null;
    }
  }
  if (body.priority !== undefined) {
    if (typeof body.priority !== "string" || !ALLOWED_PRIORITY.has(body.priority)) {
      return c.json({ error: "priority 僅允許 高 / 中 / 低" }, 400);
    }
    updates.priority = body.priority;
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !ALLOWED_STATUS.has(body.status)) {
      return c.json({ error: "status 僅允許 未開始 / 進行中 / 已完成" }, 400);
    }
    updates.status = body.status;
  }
  if (body.due_date !== undefined) {
    if (body.due_date === null || body.due_date === "") {
      updates.due_date = null;
    } else if (typeof body.due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      return c.json({ error: "due_date 必須為 YYYY-MM-DD 格式或 null" }, 400);
    } else {
      updates.due_date = body.due_date;
    }
  }
  if (body.notes !== undefined) {
    if (body.notes === null) {
      updates.notes = null;
    } else if (typeof body.notes !== "string") {
      return c.json({ error: "notes 必須為字串或 null" }, 400);
    } else {
      const trimmed = body.notes.trim();
      updates.notes = trimmed ? trimmed : null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "未提供任何可更新欄位" }, 400);
  }

  const columns = Object.keys(updates);
  // 用 postgres.js 的 sql(obj, ...keys) dynamic SET
  const updated = await sql<ActionItem[]>`
    UPDATE nb_action_items
    SET ${sql(updates, ...columns)}, updated_at = now()
    WHERE id = ${id} AND department_id = ${deptId}
    RETURNING id, meeting_id, department_id, code, description, assignee,
              priority, status, due_date, notes, created_at, updated_at
  `;
  const row = updated[0]!;

  // 自 2026-05-19 起不再寫入 Google Sheets — DB 為唯一資料來源
  return c.json(row);
});
