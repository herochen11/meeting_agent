import { Hono } from "hono";
import { sql } from "../db";
import { requireAdmin, type AdminVars } from "../auth";
import { syncDepartmentToConfig } from "../lib/dept-sync";

export const adminRoute = new Hono<{ Variables: AdminVars }>();

adminRoute.use("/api/admin/*", requireAdmin);

interface DepartmentPublic {
  id: number;
  name: string;
  slug: string;
  chat_id: string | null;
  sheet_id: string | null;
  drive_folder_id: string | null;
  created_at: Date | null;
}

// Slug 限制：小寫英數與底線、連字號
const SLUG_REGEX = /^[a-z0-9_-]{2,50}$/;

adminRoute.get("/api/admin/departments", async (c) => {
  const rows = await sql<DepartmentPublic[]>`
    SELECT id, name, slug, chat_id, sheet_id, drive_folder_id, created_at
    FROM nb_departments
    ORDER BY id
  `;
  return c.json(rows);
});

interface CreateBody {
  name?: unknown;
  slug?: unknown;
  password?: unknown;
  chat_id?: unknown;
  sheet_id?: unknown;
  drive_folder_id?: unknown;
}

adminRoute.post("/api/admin/departments", async (c) => {
  let body: CreateBody;
  try {
    body = (await c.req.json()) as CreateBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name) return c.json({ error: "name 為必填" }, 400);
  if (!slug) return c.json({ error: "slug 為必填" }, 400);
  if (!SLUG_REGEX.test(slug)) {
    return c.json(
      { error: "slug 只允許小寫英數、底線、連字號，長度 2-50" },
      400,
    );
  }
  if (!password || password.length < 6) {
    return c.json({ error: "password 至少 6 個字元" }, 400);
  }

  const chatId =
    typeof body.chat_id === "string" && body.chat_id.trim()
      ? body.chat_id.trim()
      : null;
  const sheetId =
    typeof body.sheet_id === "string" && body.sheet_id.trim()
      ? body.sheet_id.trim()
      : null;
  const driveFolderId =
    typeof body.drive_folder_id === "string" && body.drive_folder_id.trim()
      ? body.drive_folder_id.trim()
      : null;

  // 檢查 slug 唯一
  const exist = await sql<{ id: number }[]>`
    SELECT id FROM nb_departments WHERE slug = ${slug} LIMIT 1
  `;
  if (exist.length > 0) {
    return c.json({ error: "slug 已被使用" }, 409);
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });

  const inserted = await sql<DepartmentPublic[]>`
    INSERT INTO nb_departments
      (name, slug, password_hash, chat_id, sheet_id, drive_folder_id)
    VALUES
      (${name}, ${slug}, ${passwordHash}, ${chatId}, ${sheetId}, ${driveFolderId})
    RETURNING id, name, slug, chat_id, sheet_id, drive_folder_id, created_at
  `;

  // DB row 為主紀錄；同步 config/departments.json + 建立 records 資料夾。
  // 同步失敗不擋請求，只在回應帶 warning。
  const sync = await syncDepartmentToConfig({
    chatId,
    name,
    sheetId,
    driveFolderId,
  });

  if (!sync.ok && sync.warning) {
    return c.json({ ...inserted[0], warning: sync.warning }, 201);
  }
  return c.json(inserted[0], 201);
});

interface UpdateBody {
  name?: unknown;
  slug?: unknown;
  chat_id?: unknown;
  sheet_id?: unknown;
  drive_folder_id?: unknown;
}

adminRoute.patch("/api/admin/departments/:id", async (c) => {
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

  const exist = await sql<{ id: number }[]>`
    SELECT id FROM nb_departments WHERE id = ${id} LIMIT 1
  `;
  if (exist.length === 0) {
    return c.json({ error: "部門不存在" }, 404);
  }

  const updates: Record<string, string | null> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name 不可為空" }, 400);
    }
    updates.name = body.name.trim();
  }
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string" || !SLUG_REGEX.test(body.slug.trim())) {
      return c.json(
        { error: "slug 只允許小寫英數、底線、連字號，長度 2-50" },
        400,
      );
    }
    const newSlug = body.slug.trim();
    // 唯一性檢查（排除自己）
    const dup = await sql<{ id: number }[]>`
      SELECT id FROM nb_departments WHERE slug = ${newSlug} AND id <> ${id} LIMIT 1
    `;
    if (dup.length > 0) {
      return c.json({ error: "slug 已被使用" }, 409);
    }
    updates.slug = newSlug;
  }
  if (body.chat_id !== undefined) {
    if (body.chat_id === null || body.chat_id === "") {
      updates.chat_id = null;
    } else if (typeof body.chat_id !== "string") {
      return c.json({ error: "chat_id 必須為字串或 null" }, 400);
    } else {
      updates.chat_id = body.chat_id.trim();
    }
  }
  if (body.sheet_id !== undefined) {
    if (body.sheet_id === null || body.sheet_id === "") {
      updates.sheet_id = null;
    } else if (typeof body.sheet_id !== "string") {
      return c.json({ error: "sheet_id 必須為字串或 null" }, 400);
    } else {
      updates.sheet_id = body.sheet_id.trim();
    }
  }
  if (body.drive_folder_id !== undefined) {
    if (body.drive_folder_id === null || body.drive_folder_id === "") {
      updates.drive_folder_id = null;
    } else if (typeof body.drive_folder_id !== "string") {
      return c.json({ error: "drive_folder_id 必須為字串或 null" }, 400);
    } else {
      updates.drive_folder_id = body.drive_folder_id.trim();
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "未提供任何可更新欄位" }, 400);
  }

  const columns = Object.keys(updates);
  const updated = await sql<DepartmentPublic[]>`
    UPDATE nb_departments
    SET ${sql(updates, ...columns)}
    WHERE id = ${id}
    RETURNING id, name, slug, chat_id, sheet_id, drive_folder_id, created_at
  `;

  const row = updated[0];
  if (!row) {
    return c.json({ error: "更新後找不到部門資料" }, 500);
  }

  // 若本次更新動到 config 會關心的欄位（name / chat_id / sheet_id / drive_folder_id），
  // 就用更新後的最終值同步 config/departments.json（slug 不寫入 config）。
  const touchesConfigFields =
    "name" in updates ||
    "chat_id" in updates ||
    "sheet_id" in updates ||
    "drive_folder_id" in updates;

  if (touchesConfigFields) {
    const sync = await syncDepartmentToConfig({
      chatId: row.chat_id,
      name: row.name,
      sheetId: row.sheet_id,
      driveFolderId: row.drive_folder_id,
    });
    if (!sync.ok && sync.warning) {
      return c.json({ ...row, warning: sync.warning });
    }
  }

  return c.json(row);
});

interface PasswordBody {
  password?: unknown;
}

adminRoute.patch("/api/admin/departments/:id/password", async (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "無效的 id" }, 400);
  }

  let body: PasswordBody;
  try {
    body = (await c.req.json()) as PasswordBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 body" }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length < 6) {
    return c.json({ error: "password 至少 6 個字元" }, 400);
  }

  const exist = await sql<{ id: number }[]>`
    SELECT id FROM nb_departments WHERE id = ${id} LIMIT 1
  `;
  if (exist.length === 0) {
    return c.json({ error: "部門不存在" }, 404);
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });

  await sql`
    UPDATE nb_departments
    SET password_hash = ${passwordHash}
    WHERE id = ${id}
  `;

  return c.json({ success: true });
});
