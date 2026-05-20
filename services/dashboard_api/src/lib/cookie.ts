import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SESSION_SECRET ?? "";
if (!SECRET) {
  // 不馬上 throw，讓 dev 在沒設定時跑得起來但會印警告
  // 正式環境一定要設定
  console.warn(
    "[警告] 未設定 SESSION_SECRET，使用空字串。請在 .env 設定隨機長字串。",
  );
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(
    str.replace(/-/g, "+").replace(/_/g, "/") + pad,
    "base64",
  );
}

function sign(payload: string): string {
  return b64urlEncode(
    createHmac("sha256", SECRET).update(payload).digest(),
  );
}

/**
 * 把 value 用 HMAC-SHA256 簽名，並把過期時間（unix ms）嵌進去。
 * 格式：base64url(value).base64url(expiresMs).base64url(sig)
 */
export function signCookieValue(value: string, maxAgeSeconds: number): string {
  const expiresMs = Date.now() + maxAgeSeconds * 1000;
  const valueB64 = b64urlEncode(Buffer.from(value, "utf-8"));
  const expB64 = b64urlEncode(Buffer.from(String(expiresMs), "utf-8"));
  const payload = `${valueB64}.${expB64}`;
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

/**
 * 驗證簽名與過期時間，成功回傳原始 value，失敗回 null。
 */
export function verifyCookieValue(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [valueB64, expB64, sig] = parts;
  if (!valueB64 || !expB64 || !sig) return null;

  const expected = sign(`${valueB64}.${expB64}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let expiresMs: number;
  try {
    expiresMs = Number(b64urlDecode(expB64).toString("utf-8"));
  } catch {
    return null;
  }
  if (!Number.isFinite(expiresMs) || Date.now() > expiresMs) return null;

  try {
    return b64urlDecode(valueB64).toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * 組裝 Set-Cookie header value（不含 cookie name）
 */
export function buildSetCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  opts: { secure?: boolean } = {},
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
