// Google Sheets helper (service-account auth).
//
// 用於 dashboard_api 反向同步 Action Items 到對應部門的 Sheet。
// 對齊 mcp/server.py 內 _append_action_items / _update_action_item 的欄位順序：
//
//   A=編號   B=任務描述   C=負責人   D=優先級   E=狀態
//   F=預計完成時間   G=來源會議   H=會議日期   I=備註
//
// 失敗策略：呼叫端應 try/catch — 本檔不重試，DB 永遠是主。

import { google, type sheets_v4 } from "googleapis";

const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ??
  "/home/user/Agents/meeting_agent/credentials/google-service-account.json";

const SHEET_TAB = "Action Items"; // sheet1 通常叫這個；萬一不是則 fallback
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let _client: sheets_v4.Sheets | null = null;

async function getClient(): Promise<sheets_v4.Sheets> {
  if (_client) return _client;
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
  });
  _client = google.sheets({ version: "v4", auth });
  return _client;
}

/** Action Item 在 Sheet 上的欄位（依 mcp 雙寫對稱） */
export interface SheetActionItemRow {
  code: string; // A 編號
  description: string; // B 任務描述
  assignee: string; // C 負責人（空字串 → "待確認"）
  priority: string; // D 優先級
  status: string; // E 狀態
  due_date: string; // F 預計完成時間（YYYY-MM-DD 或空）
  source_meeting: string; // G 來源會議（meet_id）
  meeting_date: string; // H 會議日期（YYYY-MM-DD 或空）
  notes: string; // I 備註
}

/** 可更新的欄位（部分更新） */
export type SheetUpdates = Partial<Omit<SheetActionItemRow, "code">>;

const COL_INDEX: Record<keyof SheetActionItemRow, number> = {
  code: 1,
  description: 2,
  assignee: 3,
  priority: 4,
  status: 5,
  due_date: 6,
  source_meeting: 7,
  meeting_date: 8,
  notes: 9,
};

function colLetter(n: number): string {
  // 1->A, 2->B... 支援到 26 個欄位夠用
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** 取 sheet1（第一個分頁）的標題，後續以此為 A1 range 前綴 */
async function firstSheetTitle(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<string> {
  const meta = await client.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
  });
  const first = meta.data.sheets?.[0]?.properties?.title;
  if (!first) {
    throw new Error("Spreadsheet 沒有任何 sheet 分頁");
  }
  return first;
}

/**
 * Append 一筆 Action Item 到 Sheet（對應 _append_action_items 的單筆版本）。
 * 失敗會 throw — 由呼叫端 try/catch 並轉成 sheet_warning。
 */
export async function appendActionItemRow(
  spreadsheetId: string,
  row: SheetActionItemRow,
): Promise<void> {
  if (!spreadsheetId) throw new Error("缺少 spreadsheet_id");
  const client = await getClient();
  const title = await firstSheetTitle(client, spreadsheetId);

  const values = [
    [
      row.code,
      row.description,
      row.assignee || "待確認",
      row.priority,
      row.status,
      row.due_date,
      row.source_meeting,
      row.meeting_date,
      row.notes,
    ],
  ];

  await client.spreadsheets.values.append({
    spreadsheetId,
    range: `${title}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/**
 * 找到 code 對應的 row 並更新指定欄位（對應 _update_action_item）。
 * 找不到 row 會 throw — 由呼叫端決定要不要視為 warning。
 */
export async function updateActionItemRow(
  spreadsheetId: string,
  code: string,
  updates: SheetUpdates,
): Promise<void> {
  if (!spreadsheetId) throw new Error("缺少 spreadsheet_id");
  if (!code) throw new Error("缺少 code");
  if (!updates || Object.keys(updates).length === 0) {
    throw new Error("updates 為空");
  }

  const client = await getClient();
  const title = await firstSheetTitle(client, spreadsheetId);

  // 1) 讀整個 A 欄找 code 所在 row
  const colA = await client.spreadsheets.values.get({
    spreadsheetId,
    range: `${title}!A:A`,
  });
  const rows = colA.data.values ?? [];
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.[0] === code) {
      rowIndex = i + 1; // Sheets 是 1-based
      break;
    }
  }
  if (rowIndex < 0) {
    throw new Error(`Sheet 找不到編號 ${code}`);
  }

  // 2) 用 batchUpdate（values）一次更新所有欄位
  const data: sheets_v4.Schema$ValueRange[] = [];
  for (const [field, value] of Object.entries(updates) as [
    keyof SheetUpdates,
    string,
  ][]) {
    const colNum = COL_INDEX[field];
    if (!colNum) continue;
    data.push({
      range: `${title}!${colLetter(colNum)}${rowIndex}`,
      values: [[value ?? ""]],
    });
  }

  if (data.length === 0) return;

  await client.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
}

// 引用避免 unused warning（保留給未來擴充）
void SHEET_TAB;
