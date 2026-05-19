import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { google, type Auth } from "googleapis";
import { sql } from "../db";
import { getDeptId, requireDept, type DeptVars } from "../auth";

export const calendarRoute = new Hono<{ Variables: DeptVars }>();

calendarRoute.use("/api/calendar/*", requireDept);

// ---------------------------------------------------------------------------
// 設定 / 常數
// ---------------------------------------------------------------------------

const SESSION_SECRET = process.env.SESSION_SECRET ?? "";
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ??
  "http://localhost:8765/api/calendar/oauth-callback";
// Dashboard 前端網址（OAuth 完成後 redirect 回去）。
// 沒設 env 就走 vite dev 預設 5173；若是部署到同網域，把這個改成 ""（同源）即可。
const DASHBOARD_WEB_BASE_URL =
  process.env.DASHBOARD_WEB_BASE_URL ?? "http://localhost:5173";

const CALENDAR_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 分鐘有效

// ---------------------------------------------------------------------------
// state 簽章（CSRF 防護）
// ---------------------------------------------------------------------------

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

/** state = base64url(payloadJson).base64url(sig)，payload = { d, n, t } */
function signState(deptId: number): string {
  const payload = JSON.stringify({
    d: deptId,
    n: randomBytes(16).toString("hex"),
    t: Date.now(),
  });
  const payloadB64 = b64urlEncode(Buffer.from(payload, "utf-8"));
  const sig = b64urlEncode(
    createHmac("sha256", SESSION_SECRET).update(payloadB64).digest(),
  );
  return `${payloadB64}.${sig}`;
}

function verifyState(state: string | undefined): { deptId: number } | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expected = b64urlEncode(
    createHmac("sha256", SESSION_SECRET).update(payloadB64).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { d?: unknown; t?: unknown };
  const deptId = typeof obj.d === "number" ? obj.d : null;
  const t = typeof obj.t === "number" ? obj.t : null;
  if (deptId === null || t === null) return null;
  if (Date.now() - t > STATE_MAX_AGE_MS) return null;
  return { deptId };
}

// ---------------------------------------------------------------------------
// OAuth client / 共用 helper
// ---------------------------------------------------------------------------

function newOauthClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI,
  );
}

interface CalendarAccountRow {
  id: number;
  department_id: number;
  google_email: string;
  refresh_token: string;
  access_token: string | null;
  token_expires_at: Date | null;
  scopes: string[] | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * 用 DB 帳號建立 OAuth client，需要時自動 refresh。
 * 成功時把新的 access_token / expires_at 寫回 DB。
 */
async function buildAuthorizedClient(
  account: CalendarAccountRow,
): Promise<Auth.OAuth2Client> {
  const client = newOauthClient();
  client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    expiry_date: account.token_expires_at
      ? account.token_expires_at.getTime()
      : undefined,
    scope: (account.scopes ?? []).join(" "),
  });

  // googleapis 會在 expiry < 5 分鐘 / 過期時自動用 refresh_token 換新 access_token
  const { token } = await client.getAccessToken();
  const creds = client.credentials;
  if (token && creds.expiry_date) {
    // 若 access_token 有更新，把新值寫回 DB
    if (token !== account.access_token) {
      await sql`
        UPDATE nb_calendar_accounts
        SET access_token = ${token},
            token_expires_at = to_timestamp(${creds.expiry_date / 1000}),
            updated_at = NOW()
        WHERE id = ${account.id}
      `;
    }
  }
  return client;
}

async function getActiveAccountsForDept(
  deptId: number,
): Promise<CalendarAccountRow[]> {
  return await sql<CalendarAccountRow[]>`
    SELECT id, department_id, google_email, refresh_token, access_token,
           token_expires_at, scopes, active, created_at, updated_at
    FROM nb_calendar_accounts
    WHERE department_id = ${deptId} AND active = TRUE
    ORDER BY id ASC
  `;
}

// ---------------------------------------------------------------------------
// 路由：/api/calendar/connect
// ---------------------------------------------------------------------------

calendarRoute.get("/api/calendar/connect", (c) => {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    return c.json({ error: "伺服器未設定 Google OAuth 憑證" }, 500);
  }
  if (!SESSION_SECRET) {
    return c.json({ error: "伺服器未設定 SESSION_SECRET" }, 500);
  }

  const deptId = getDeptId(c);
  const state = signState(deptId);

  const client = newOauthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // 強制取得 refresh_token
    scope: CALENDAR_SCOPES,
    state,
    include_granted_scopes: true,
  });

  return c.redirect(url, 302);
});

// ---------------------------------------------------------------------------
// 路由：/api/calendar/oauth-callback
// ---------------------------------------------------------------------------

interface GoogleUserInfo {
  email?: string;
  verified_email?: boolean;
  name?: string;
  picture?: string;
}

function safeReturnUrl(extra: string): string {
  // DASHBOARD_WEB_BASE_URL 可為空字串（同源部署）或完整 URL
  const base = DASHBOARD_WEB_BASE_URL.replace(/\/$/, "");
  return `${base}/calendar${extra}`;
}

calendarRoute.get("/api/calendar/oauth-callback", async (c) => {
  // ⚠️ 這個 endpoint 是 OAuth provider 回呼進來的，session cookie 也會帶到（Lax + same-site redirect）。
  // requireDept 已套用，會驗證使用者仍登入。但 callback 真正的部門依據是 state 內嵌的 dept_id，不依賴 cookie。
  const code = c.req.query("code");
  const stateRaw = c.req.query("state");
  const oauthError = c.req.query("error");

  if (oauthError) {
    return c.redirect(
      safeReturnUrl(`?connected=0&error=${encodeURIComponent(oauthError)}`),
      302,
    );
  }
  if (!code || !stateRaw) {
    return c.redirect(safeReturnUrl("?connected=0&error=missing_params"), 302);
  }

  const stateOk = verifyState(stateRaw);
  if (!stateOk) {
    return c.redirect(safeReturnUrl("?connected=0&error=invalid_state"), 302);
  }

  // 安全：cookie 的 deptId 必須與 state 內嵌的 deptId 一致（防止 A 部門用 B 部門 state callback）
  const sessionDeptId = getDeptId(c);
  if (sessionDeptId !== stateOk.deptId) {
    return c.redirect(safeReturnUrl("?connected=0&error=state_mismatch"), 302);
  }
  const deptId = stateOk.deptId;

  const client = newOauthClient();
  let tokens: Auth.Credentials;
  try {
    const { tokens: t } = await client.getToken(code);
    tokens = t;
  } catch (err) {
    console.error("[calendar oauth-callback] getToken 失敗", (err as Error).message);
    return c.redirect(safeReturnUrl("?connected=0&error=token_exchange"), 302);
  }

  if (!tokens.refresh_token) {
    // 若使用者之前授權過、又沒帶 prompt=consent 進來，Google 不會給 refresh_token
    // 我們設了 prompt=consent，理論上一定會給；萬一沒有就請使用者重連
    return c.redirect(safeReturnUrl("?connected=0&error=no_refresh_token"), 302);
  }

  // 拿 user email（用 userinfo endpoint）
  client.setCredentials(tokens);
  let userEmail: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const userInfoRes = await oauth2.userinfo.get();
    const info = userInfoRes.data as GoogleUserInfo;
    if (info.email) userEmail = info.email;
  } catch (err) {
    console.error("[calendar oauth-callback] userinfo 失敗", (err as Error).message);
  }
  if (!userEmail) {
    return c.redirect(safeReturnUrl("?connected=0&error=no_email"), 302);
  }

  const accessToken = tokens.access_token ?? null;
  const expiresAtMs = tokens.expiry_date ?? null;
  const scopeList = (tokens.scope ?? "").split(" ").filter(Boolean);

  try {
    await sql`
      INSERT INTO nb_calendar_accounts
        (department_id, google_email, refresh_token, access_token, token_expires_at, scopes, active)
      VALUES
        (${deptId}, ${userEmail}, ${tokens.refresh_token}, ${accessToken},
         ${expiresAtMs ? new Date(expiresAtMs) : null}, ${scopeList}, TRUE)
      ON CONFLICT (department_id, google_email) DO UPDATE
        SET refresh_token = EXCLUDED.refresh_token,
            access_token = EXCLUDED.access_token,
            token_expires_at = EXCLUDED.token_expires_at,
            scopes = EXCLUDED.scopes,
            active = TRUE,
            updated_at = NOW()
    `;
  } catch (err) {
    console.error("[calendar oauth-callback] UPSERT 失敗", (err as Error).message);
    return c.redirect(safeReturnUrl("?connected=0&error=db_write"), 302);
  }

  return c.redirect(safeReturnUrl("?connected=1"), 302);
});

// ---------------------------------------------------------------------------
// 路由：/api/calendar/accounts
// ---------------------------------------------------------------------------

calendarRoute.get("/api/calendar/accounts", async (c) => {
  const deptId = getDeptId(c);
  const rows = await sql<
    {
      id: number;
      google_email: string;
      active: boolean;
      created_at: Date;
    }[]
  >`
    SELECT id, google_email, active, created_at
    FROM nb_calendar_accounts
    WHERE department_id = ${deptId} AND active = TRUE
    ORDER BY id ASC
  `;
  return c.json({
    accounts: rows.map((r) => ({
      id: r.id,
      google_email: r.google_email,
      active: r.active,
      created_at: r.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// 路由：/api/calendar/events?from=<ISO>&to=<ISO>
// ---------------------------------------------------------------------------

interface NormalizedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  attendees?: { email: string; displayName?: string }[];
  meetUrl?: string;
  meetingCode?: string;
  source_account_email: string;
}

function extractMeetUrl(
  conferenceData:
    | {
        entryPoints?: { entryPointType?: string | null; uri?: string | null }[];
      }
    | null
    | undefined,
): { url: string; code: string } | null {
  if (!conferenceData?.entryPoints) return null;
  for (const ep of conferenceData.entryPoints) {
    if (ep.entryPointType === "video" && ep.uri) {
      // Google Meet URL 通常為 https://meet.google.com/abc-defg-hij
      const m = /meet\.google\.com\/([a-z0-9-]+)/i.exec(ep.uri);
      return { url: ep.uri, code: m ? m[1]! : "" };
    }
  }
  return null;
}

calendarRoute.get("/api/calendar/events", async (c) => {
  const deptId = getDeptId(c);
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ error: "from / to 為必填（ISO 8601）" }, 400);
  }
  // 寬鬆驗證
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (
    Number.isNaN(fromDate.getTime()) ||
    Number.isNaN(toDate.getTime()) ||
    fromDate >= toDate
  ) {
    return c.json({ error: "from / to 格式不合法或順序錯誤" }, 400);
  }

  const accounts = await getActiveAccountsForDept(deptId);
  if (accounts.length === 0) {
    return c.json({ events: [] });
  }

  const allEvents: NormalizedEvent[] = [];
  const errors: { email: string; message: string }[] = [];

  for (const account of accounts) {
    let client: Auth.OAuth2Client;
    try {
      client = await buildAuthorizedClient(account);
    } catch (err) {
      // refresh 失敗 — 可能是 refresh_token 被撤銷
      errors.push({
        email: account.google_email,
        message: `授權失效，請重新連結（${(err as Error).message}）`,
      });
      continue;
    }

    try {
      const cal = google.calendar({ version: "v3", auth: client });
      const res = await cal.events.list({
        calendarId: "primary",
        timeMin: fromDate.toISOString(),
        timeMax: toDate.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
      });
      const items = res.data.items ?? [];
      for (const ev of items) {
        const start =
          ev.start?.dateTime ??
          (ev.start?.date ? `${ev.start.date}T00:00:00` : null);
        const end =
          ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : null);
        if (!start || !end || !ev.id) continue;

        const meet = extractMeetUrl(ev.conferenceData ?? null);
        const norm: NormalizedEvent = {
          id: ev.id,
          title: ev.summary ?? "(無標題)",
          start,
          end,
          source_account_email: account.google_email,
        };
        if (ev.description) norm.description = ev.description;
        if (ev.attendees && ev.attendees.length > 0) {
          norm.attendees = ev.attendees
            .filter((a) => a.email)
            .map((a) => {
              const out: { email: string; displayName?: string } = {
                email: a.email!,
              };
              if (a.displayName) out.displayName = a.displayName;
              return out;
            });
        }
        if (meet) {
          norm.meetUrl = meet.url;
          if (meet.code) norm.meetingCode = meet.code;
        }
        allEvents.push(norm);
      }
    } catch (err) {
      errors.push({
        email: account.google_email,
        message: (err as Error).message,
      });
    }
  }

  allEvents.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  return c.json({ events: allEvents, errors });
});

// ---------------------------------------------------------------------------
// 路由：DELETE /api/calendar/accounts/:id
// ---------------------------------------------------------------------------

calendarRoute.delete("/api/calendar/accounts/:id", async (c) => {
  const deptId = getDeptId(c);
  const idParam = c.req.param("id");
  const id = Number.parseInt(idParam ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "id 不合法" }, 400);
  }

  // 確認帳號屬於本部門
  const rows = await sql<{ id: number; refresh_token: string }[]>`
    SELECT id, refresh_token FROM nb_calendar_accounts
    WHERE id = ${id} AND department_id = ${deptId} AND active = TRUE
    LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: "找不到此帳號或無權限" }, 404);
  }
  const refreshToken = rows[0]!.refresh_token;

  // 嘗試撤銷 token（失敗不擋）
  try {
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
  } catch (err) {
    console.warn(
      "[calendar disconnect] revoke 失敗（忽略）",
      (err as Error).message,
    );
  }

  // 軟刪除：保留 row 但 active=false，並清掉敏感欄位
  await sql`
    UPDATE nb_calendar_accounts
    SET active = FALSE,
        refresh_token = '',
        access_token = NULL,
        token_expires_at = NULL,
        updated_at = NOW()
    WHERE id = ${id} AND department_id = ${deptId}
  `;

  return c.json({ success: true });
});
