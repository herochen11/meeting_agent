import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { sql, type Department } from "../db";
import {
  signCookieValue,
} from "../lib/cookie";
import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE,
  DEPT_COOKIE,
  DEPT_MAX_AGE,
} from "../auth";

export const authRoute = new Hono();

interface LoginBody {
  slug?: unknown;
  password?: unknown;
}

authRoute.post("/api/auth/login", async (c) => {
  let body: LoginBody;
  try {
    body = (await c.req.json()) as LoginBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 slug 與 password" }, 400);
  }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!slug || !password) {
    return c.json({ error: "請提供 slug 與 password" }, 400);
  }

  const rows = await sql<Department[]>`
    SELECT id, name, slug, password_hash
    FROM nb_departments
    WHERE slug = ${slug}
    LIMIT 1
  `;
  const dept = rows[0];
  if (!dept) {
    return c.json({ error: "帳號或密碼錯誤" }, 401);
  }

  let ok = false;
  try {
    ok = await Bun.password.verify(password, dept.password_hash);
  } catch {
    ok = false;
  }
  if (!ok) {
    return c.json({ error: "帳號或密碼錯誤" }, 401);
  }

  const signed = signCookieValue(String(dept.id), DEPT_MAX_AGE);
  setCookie(c, DEPT_COOKIE, signed, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: DEPT_MAX_AGE,
  });

  return c.json({
    ok: true,
    department: { id: dept.id, name: dept.name, slug: dept.slug },
  });
});

interface AdminBody {
  password?: unknown;
}

authRoute.post("/api/auth/admin", async (c) => {
  let body: AdminBody;
  try {
    body = (await c.req.json()) as AdminBody;
  } catch {
    return c.json({ error: "請提供 JSON 格式的 password" }, 400);
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    return c.json({ error: "請提供 password" }, 400);
  }

  const rows = await sql<{ value: string | null }[]>`
    SELECT value FROM nb_admin WHERE key = 'admin_password_hash' LIMIT 1
  `;
  const hash = rows[0]?.value;
  if (!hash) {
    return c.json({ error: "Admin 尚未設定" }, 500);
  }

  let ok = false;
  try {
    ok = await Bun.password.verify(password, hash);
  } catch {
    ok = false;
  }
  if (!ok) {
    return c.json({ error: "密碼錯誤" }, 401);
  }

  const signed = signCookieValue("admin", ADMIN_MAX_AGE);
  setCookie(c, ADMIN_COOKIE, signed, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: ADMIN_MAX_AGE,
  });
  return c.json({ ok: true });
});

authRoute.post("/api/auth/logout", async (c) => {
  setCookie(c, DEPT_COOKIE, "", {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 0,
  });
  setCookie(c, ADMIN_COOKIE, "", {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 0,
  });
  return c.json({ ok: true });
});
