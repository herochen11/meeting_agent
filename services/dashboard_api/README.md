# Dashboard API (NB-DASH Phase C1)

NoirsBoxes 會議管理 dashboard 後端 API。

## 技術棧

- Runtime: [Bun](https://bun.sh)
- HTTP framework: [Hono](https://hono.dev)
- DB driver: [postgres.js](https://github.com/porsager/postgres)
- 密碼雜湊: Bun 內建 `Bun.password.verify`（bcrypt 相容）
- Session: HTTP-only signed cookie（HMAC-SHA256）

## 環境變數

複製 `.env.example` 為 `.env` 並調整。

| 變數 | 說明 |
|------|------|
| `PORT` | HTTP 監聽 port（預設 8765） |
| `DATABASE_URL` | Vexa Postgres 連線字串 |
| `SESSION_SECRET` | Cookie 簽名 secret（請改成隨機字串） |
| `RECORDS_DIR` | Markdown 逐字稿根目錄 |
| `VEXA_API_BASE` | Vexa API gateway base URL（預設 `http://localhost:8056`） |
| `VEXA_USER_API_KEY` | Vexa user API key（呼叫 bot 派發 API 用） |
| `MEETING_MAP_PATH` | meeting_map.json 路徑（meet_id → chat_id 對應） |

## 啟動

```bash
make install   # 安裝相依（bun install）
make start     # 直接啟動
make dev       # 啟動 + watch（hot reload）
```

或：

```bash
bun install
bun run start
```

## 認證

### 部門登入
```
POST /api/auth/login
Content-Type: application/json

{"slug": "production", "password": "changeme123"}
```

成功回傳 `nb_session` cookie（7 天）。

### Admin 登入
```
POST /api/auth/admin
Content-Type: application/json

{"password": "admin123"}
```

成功回傳 `nb_admin` cookie（4 小時）。

## 讀取 endpoints

所有 `/api/*` endpoint（除了 `/api/auth/*`）都需要部門 session cookie。

| Method | Path | 說明 |
|--------|------|------|
| GET | `/health` | Health check（無需 auth） |
| GET | `/api/action-items` | 該部門所有 action items |
| GET | `/api/meetings` | 該部門所有會議（不含逐字稿全文） |
| GET | `/api/meetings/:id` | 單一會議詳情 + 對應 action items |
| GET | `/api/meetings/:id/transcript` | 會議逐字稿 markdown |

## 寫入 endpoints（需部門 session）

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/action-items` | 新增 Action Item（code 未帶會自動產生 MMDD_N） |
| PATCH | `/api/action-items/:id` | 更新 Action Item 欄位（description, assignee, priority, status, due_date, notes） |

## Bot endpoints（需部門 session，呼叫 Vexa HTTP API）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/bot/status` | 該部門名下進行中的 bot |
| POST | `/api/bot/join` | 派發 bot 進 Google Meet（body: `{meet_id, bot_name?}`） |
| POST | `/api/bot/stop` | 停止 bot（body: `{meet_id}`） |

## Admin endpoints（需 admin session）

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/admin/departments` | 列出所有部門（不回 password_hash） |
| POST | `/api/admin/departments` | 新增部門（body: `{name, slug, password, chat_id?, sheet_id?, drive_folder_id?}`） |
| PATCH | `/api/admin/departments/:id` | 編輯部門（name, slug, chat_id, sheet_id, drive_folder_id） |
| PATCH | `/api/admin/departments/:id/password` | 重設部門密碼（body: `{password}`） |

## 部門隔離

所有 query 都以 cookie 解出的 `dept_id` 作為 `WHERE department_id = $1` 強制過濾。

跨部門存取會回 404。

## Slug 對應

| Slug | 部門 |
|------|------|
| `production` | 生管部門 |
| `test` | 測試群 |
| `test2` | 測試2群 |
