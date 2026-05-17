import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { verifyCookieValue } from "./lib/cookie";

export const DEPT_COOKIE = "nb_session";
export const ADMIN_COOKIE = "nb_admin";
export const DEPT_MAX_AGE = 60 * 60 * 24 * 7; // 7 天
export const ADMIN_MAX_AGE = 60 * 60 * 4; // 4 小時

export type DeptVars = {
  deptId: number;
};

export type AdminVars = {
  admin: true;
};

/**
 * 部門 session middleware：要求 cookie 帶有合法 dept_id。
 * 失敗回 401 JSON。
 */
export const requireDept: MiddlewareHandler<{ Variables: DeptVars }> = async (
  c,
  next,
) => {
  const raw = getCookie(c, DEPT_COOKIE);
  const value = verifyCookieValue(raw);
  if (!value) {
    return c.json({ error: "請先登入" }, 401);
  }
  const deptId = Number.parseInt(value, 10);
  if (!Number.isInteger(deptId) || deptId <= 0) {
    return c.json({ error: "請先登入" }, 401);
  }
  c.set("deptId", deptId);
  await next();
};

/**
 * Admin session middleware
 */
export const requireAdmin: MiddlewareHandler<{ Variables: AdminVars }> = async (
  c,
  next,
) => {
  const raw = getCookie(c, ADMIN_COOKIE);
  const value = verifyCookieValue(raw);
  if (value !== "admin") {
    return c.json({ error: "請先以 admin 身份登入" }, 401);
  }
  c.set("admin", true);
  await next();
};

export function getDeptId(c: Context): number {
  const id = c.get("deptId");
  if (typeof id !== "number") {
    throw new Error("缺少 deptId context（請套用 requireDept middleware）");
  }
  return id;
}
