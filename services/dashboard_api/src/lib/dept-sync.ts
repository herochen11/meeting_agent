import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

// 解析 config/departments.json 的路徑：
//   1. 優先讀 CONFIG_FILE env（與 recap.ts 一致）
//   2. 否則由 RECORDS_DIR 推回專案根目錄（records 的 parent）再接 config/departments.json
function resolveConfigPath(): string {
  const fromEnv = process.env.CONFIG_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const recordsDir = process.env.RECORDS_DIR;
  if (!recordsDir || !recordsDir.trim()) {
    throw new Error("RECORDS_DIR / CONFIG_FILE 皆未設定，無法定位 config/departments.json");
  }
  const projectRoot = resolve(recordsDir.trim(), "..");
  return join(projectRoot, "config", "departments.json");
}

function resolveRecordsDir(): string {
  const recordsDir = process.env.RECORDS_DIR;
  if (!recordsDir || !recordsDir.trim()) {
    throw new Error("RECORDS_DIR 未設定，無法建立 records 資料夾");
  }
  return resolve(recordsDir.trim());
}

// departments.json 中單一部門 entry（保留未知欄位）
interface DepartmentEntry {
  chat_id?: string;
  name?: string;
  sheet_id?: string;
  drive_folder_id?: string;
  [key: string]: unknown;
}

// 整個 config 結構（保留未知 top-level 欄位，例如 _deprecated）
interface ConfigShape {
  departments?: DepartmentEntry[];
  [key: string]: unknown;
}

export interface DeptSyncFields {
  chatId: string | null;
  name: string;
  sheetId: string | null;
  driveFolderId: string | null;
}

export interface DeptSyncResult {
  // 同步成功（含「因無 chat_id 而略過」也算成功，不需要警告）
  ok: boolean;
  // 失敗時的中文警告字串（供 API response 的 warning 欄位）
  warning?: string;
}

/**
 * 將部門 upsert 進 config/departments.json，並建立本地 records/<name>/ 資料夾。
 *
 * - 以 chat_id 為 key：有同 chat_id 的 entry 就更新 name/sheet_id/drive_folder_id，否則 append。
 * - chat_id 為空/null 時：略過 config 寫入（config 以 chat_id 為 key），但 records 資料夾仍會建立。
 * - 保留檔案中既有的格式（2 空格縮排）與未知欄位（含 _deprecated、unfinished_view_gid 等）。
 * - 中文字元不轉成 \uXXXX。
 * - 讀寫失敗只回傳 warning，不丟例外（由呼叫端決定是否擋請求 — 此處設計為不擋）。
 */
export async function syncDepartmentToConfig(
  fields: DeptSyncFields,
): Promise<DeptSyncResult> {
  // 先建立 records 資料夾（非致命，獨立 try/catch）
  await ensureRecordsFolder(fields.name);

  // chat_id 為空 → 略過 config 寫入（config 以 chat_id 為 key）
  if (!fields.chatId) {
    console.log(
      `[dept-sync] 部門「${fields.name}」未提供 chat_id，略過 config/departments.json 同步（僅建立 DB row 與 records 資料夾）`,
    );
    return { ok: true };
  }

  let configPath: string;
  try {
    configPath = resolveConfigPath();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      warning: `DB 已建立，但 config/departments.json 同步失敗：${reason}，請手動補`,
    };
  }

  try {
    let config: ConfigShape;
    try {
      const raw = await readFile(configPath, "utf-8");
      config = JSON.parse(raw) as ConfigShape;
    } catch {
      // 檔案不存在或解析失敗 → 以空結構起手
      config = {};
    }

    const departments: DepartmentEntry[] = Array.isArray(config.departments)
      ? config.departments
      : [];

    const idx = departments.findIndex(
      (d) => typeof d.chat_id === "string" && d.chat_id === fields.chatId,
    );

    if (idx >= 0) {
      // 更新既有 entry：只動 name/sheet_id/drive_folder_id，其餘未知欄位原樣保留
      const existing = departments[idx];
      existing.name = fields.name;
      existing.sheet_id = fields.sheetId ?? "";
      existing.drive_folder_id = fields.driveFolderId ?? "";
    } else {
      // 新增 entry
      departments.push({
        chat_id: fields.chatId,
        name: fields.name,
        sheet_id: fields.sheetId ?? "",
        drive_folder_id: fields.driveFolderId ?? "",
      });
    }

    config.departments = departments;

    // 2 空格縮排；JSON.stringify 預設保留中文字元（不會轉 \uXXXX）；補一個結尾換行
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configPath, serialized, "utf-8");
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      warning: `DB 已建立，但 config/departments.json 同步失敗：${reason}，請手動補`,
    };
  }
}

/**
 * 建立本地 records/<name>/ 資料夾（recursive，已存在不報錯）。
 * 非致命：失敗只 log warning，不丟例外。
 */
async function ensureRecordsFolder(name: string): Promise<void> {
  if (!name || !name.trim()) return;
  try {
    const recordsDir = resolveRecordsDir();
    const target = join(recordsDir, name.trim());
    await mkdir(target, { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[dept-sync] 建立 records 資料夾失敗（部門「${name}」）：${reason}`,
    );
  }
}
