# NoirsBoxes AI 會議助理（T3）

AI 參與 Google Meet 會議，自動產出會議記錄與行動清單，追蹤進度與自動跟催。

## 系統架構

```
TG 群組訊息
    ↓ Claude Code Channels（telegram plugin）
Claude Code Session（WSL）
    ↓ 透過 MCP tools
    ├── Vexa MCP → 加入會議 / 查狀態 / 取逐字稿 / summarize
    ├── Google Sheets MCP（gspread + Service Account）→ 讀寫 Action Items
    ├── Google Docs MCP（Service Account）→ 寫入會議記錄
    └── Google Drive MCP（Claude.ai 連接）→ 建立資料夾和空白 Doc

會議結束
    ↓ meeting-api POST http://host.docker.internal:8901/hooks/meeting-completed
    ↓ webhook-channel.ts（Bun，port 8901）接收
    ↓ 推 channel notification 給 Claude Code session
    ↓ Claude 自動：summarize → Google Sheets → Google Doc → 發 TG
```

## 專案結構

```
.
├── README.md                          ← 本文件
├── CLAUDE.md                          ← Claude Code 行為規則
├── vexa.sh                            ← 管理腳本（啟動/關閉/重啟/狀態）
├── .env                               ← 環境變數（不進 git）
├── .env.example                       ← 環境變數範本
├── .mcp.json                          ← webhook channel MCP 設定
├── .gitignore
├── .claude/
│   ├── settings.json                  ← Claude Code permissions + MCP + hooks
│   └── hooks/
│       └── block-google-delete.sh     ← PreToolUse hook 防止誤刪 Google 資料
├── config/
│   ├── departments.json               ← 部門 + 人員對應表（不進 git）
│   └── departments.example.json       ← 對應表範本
├── credentials/
│   └── google-service-account.json    ← Google Service Account 金鑰（不進 git）
├── mcp/
│   ├── server.py                      ← MCP server（所有 17 個 tools）
│   └── webhook-channel.ts             ← 會議結束通知 + 跟催觸發
├── deploy/compose/
│   └── docker-compose.yml             ← Vexa 0.10.6 Docker Compose
└── services/                          ← Vexa 原始碼（官方 + 修正）
    ├── vexa-bot/
    ├── meeting-api/
    ├── runtime-api/
    └── api-gateway/
```

## MCP Tools 清單（18 個）

| 分類 | Tool | 說明 |
|---|---|---|
| Vexa | `join_meeting` | 送 bot 進 Google Meet |
| Vexa | `stop_bot` | 停止 bot（需手動確認） |
| Vexa | `get_status` | 查詢 bot 狀態 |
| Vexa | `get_meetings` | 列出最近會議 |
| Vexa | `get_transcript` | 取得逐字稿 |
| Vexa | `summarize_meeting` | 讀取逐字稿準備摘要 |
| Sheets | `create_sheet` | 建立新 Sheet + 設表頭 + 分享 |
| Sheets | `init_sheet_headers` | 為現有 Sheet 補表頭 |
| Sheets | `append_action_items` | 新增 Action Items |
| Sheets | `update_action_item` | 更新單一 Action Item 欄位 |
| Sheets | `get_action_items` | 讀取 Action Items（可篩選） |
| Docs | `write_doc` | 寫入內容到 Google Doc |
| Cron | `set_cron` | 建立/更新定時任務 |
| Cron | `list_crons` | 列出所有定時任務 |
| Cron | `delete_cron` | 刪除定時任務 |
| Config | `get_config` | 讀取部門 + 人員對應表 |
| Config | `add_department` | 新增部門 |
| Config | `update_member` | 更新人員 TG Username / 逐字稿名字 |
| TG 通知 | `send_processing` | 發送「處理中」提示，回傳 message_id |

## Docker 服務（Vexa 0.10.6）

| 服務 | Port | 說明 | 必要 |
|---|---|---|---|
| api-gateway | 8056 | API 入口 | ✅ |
| meeting-api | 8080（內部） | Bot 生命週期 + 逐字稿 + webhook | ✅ |
| runtime-api | 8090（內部） | Bot Docker container 管理 | ✅ |
| redis | 6379 | 多服務共用 | ✅ |
| postgres | 5458 | 資料庫 | ✅ |
| minio | 9000 | 錄音檔物件儲存 | ✅ |
| admin-api | 8057 | 建 user/token，按需啟動 | 按需 |

## 本地服務（非 Docker）

| 服務 | Port | 說明 |
|---|---|---|
| speaches | 8020 | 本地 Whisper（取代 Vexa Cloud 轉錄） |
| dashboard_api | 8765 | Dashboard 後端 API（Bun + Hono） |
| dashboard_web | 5173 | Dashboard 前端（Vite + React） |
| webhook-channel | 8901 | 會議結束通知 + 跟催觸發 |

---

# Dashboard

公司內部使用的網頁介面，補足 Telegram bot 的不足：

- 📋 Action Items 看板（依負責人 / 狀態分組、可編輯）
- 🎙️ 會議記錄瀏覽（含摘要、Action Items、逐字稿）
- 🤖 Bot 控制台（即時查看狀態、派發 / 停止 bot）
- 🔐 部門權限隔離 + 管理員後台

## 啟動方式

Dashboard 已整合到 `vexa.sh`：

```bash
./vexa.sh up        # 啟動 Vexa stack + speaches + dashboard
./vexa.sh down      # 全部關閉
./vexa.sh status    # 查看所有服務狀態（含 dashboard PID / port）
./vexa.sh restart   # 全部重啟
```

也可以單獨管理：

```bash
./vexa.sh dashboard-up    # 只啟動 dashboard（api + web）
./vexa.sh dashboard-down  # 只關閉 dashboard
```

## 開啟網頁

啟動後在這台電腦的瀏覽器開：

```
http://localhost:5173
```

## 預設帳密

| 角色 | Slug / 入口 | 預設密碼 |
|---|---|---|
| 生管部門 | `production` | `changeme123` |
| 測試群 | `test` | `changeme123` |
| 測試2群 | `test2` | `changeme123` |
| 管理員 | （`/admin/login`） | `admin123` |

> ⚠️ **務必透過 Admin 介面儘早改掉所有預設密碼。**

## 內網 vs 公司網路存取

預設只能本機（127.0.0.1）連線。要讓同公司其他電腦也能用：

| 模式 | 適用 | 操作 |
|---|---|---|
| **localhost only**（預設） | 只有這台機器的瀏覽器可進 | `cd services/dashboard_api && make local`、`cd services/dashboard_web && make local` |
| **LAN 開放** | 同公司網路所有電腦可進 | 兩邊都 `make lan`，需手動重啟 dashboard_api（Vite 自動 reload）|

切到 LAN 模式後，公司其他電腦可用 `http://<這台機器的 IP>:5173` 連線。**外網仍進不來**（除非路由器有 port forwarding）。

## 服務細節

| 元件 | Port | Log 位置 | PID file |
|---|---|---|---|
| dashboard_api（Bun + Hono） | 8765 | `/tmp/dashboard_api.log` | `/tmp/dashboard_api.pid` |
| dashboard_web（Vite + React） | 5173 | `/tmp/dashboard_web.log` | `/tmp/dashboard_web.pid` |

直接讀 log：
```bash
tail -f /tmp/dashboard_api.log
tail -f /tmp/dashboard_web.log
```

## 資料來源

Dashboard 讀取的資料源（**DB 主、Sheet 鏡像**）：

- **PostgreSQL `nb_*` 4 個 table**（Vexa 共用 DB 內）
  - `nb_departments`、`nb_meetings`、`nb_action_items`、`nb_admin`
- **本地 Markdown**：`records/{部門}/MMDD_{標題}_{meet-id}.md`（前端逐字稿渲染用）
- **Google Sheet 同步**：Telegram bot 改 Action Item 時自動雙寫 DB + Sheet，保持兩邊一致

## 常見問題

**Q：登入後出現「請先登入」**
A：Cookie 沒帶上。確認瀏覽器允許 cookie，或 incognito 試試。

**Q：Bot 控制台顯示「Vexa 無法連線」**
A：Vexa 服務沒起來，跑 `./vexa.sh status` 確認。

**Q：改了 .env 沒生效**
A：dashboard_api 不自動 reload，要 `./vexa.sh dashboard-down && ./vexa.sh dashboard-up`。

**Q：Dashboard 跟 Telegram 改的東西不同步**
A：應該已自動同步（DB+Sheet 雙寫）。若還是不同步，看 `/tmp/dashboard_api.log` 找錯誤訊息。

---

# 部署指南

## 環境需求

- **作業系統**：Windows + WSL2（Ubuntu 24）或原生 Linux
- **Docker**：Docker Desktop（Windows）或 Docker Engine（Linux），需支援 compose v2
- **Python**：3.10+
- **Bun**：用於 webhook-channel.ts
- **Claude Code**：需安裝且有 Anthropic 存取權限
- **Cron**：用於每日跟催定時任務（WSL 預設未啟用，需手動開啟）
- **Google 帳號**：用於 Google Drive / Calendar MCP 連接

## 部署步驟

### Step 1：Clone 專案

```bash
git clone <repo-url>
cd vexa
```

### Step 2：建立環境變數

```bash
cp .env.example .env
```

編輯 `.env`，填入以下必要值：

| 變數 | 說明 | 取得方式 |
|---|---|---|
| `TRANSCRIPTION_SERVICE_TOKEN` | Vexa 轉錄服務 token | 向 Vexa 申請 |
| `ADMIN_TOKEN` | Admin API 認證 | 自訂密碼 |
| `VEXA_USER_API_KEY` | MCP 用的 API key（需 bot+tx scope） | Step 6 產生 |
| `BOT_TOKEN` | Telegram Bot token | 透過 @BotFather 建立 |

### Step 3：設定 Google Service Account

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案
2. 啟用 API：Google Sheets API、Google Docs API、Google Drive API
3. 建立 Service Account → 下載 JSON 金鑰
4. 將金鑰放到 `credentials/google-service-account.json`
5. 記下 Service Account email（形如 `xxx@xxx.iam.gserviceaccount.com`）

如需修改分享對象 email：
```bash
# 在 .env 加入
SHARE_WITH_EMAIL=your-email@gmail.com
```

### Step 4：建立部門對應表

```bash
cp config/departments.example.json config/departments.json
```

部門資料會在系統運行時透過 TG 指令自動建立，初始保持空白即可。

### Step 4.5：設定 Google Calendar OAuth（Dashboard 月曆 Tab 用）

> ℹ️ 跟 Step 3 的 Service Account 是不同機制。**Service Account 在 2026-05-19 移除 Drive 流程後已不再被現有流程呼叫**（Step 3 可略過）。Calendar Tab 用「使用者級 OAuth」：每個使用者進 Dashboard 點「連結 Google 行事曆」自己同意授權，refresh_token 存到 dashboard_api DB。

設定步驟（要 GCP Console 操作，約 10-15 分鐘）：

1. 進 https://console.cloud.google.com/，建立新專案（命名隨意）
2. **APIs & Services → Library** → 搜「Google Calendar API」→ Enable
3. **APIs & Services → OAuth consent screen**（新版 UI 可能拆成 Branding / Audience / Data access / Clients 幾個 tab）：
   - User Type / 使用者類型：選 **External**（gmail 帳號也能用；Workspace 可選 Internal 限網域內）
   - Branding tab：填 App name、User support email、Developer contact information
   - Data access / Scopes tab：加兩個 scope：
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/calendar.events.readonly`
   - Audience / Test users tab：把要連結的 Google email 全部加進去（Testing 模式最多 100 個）
4. **APIs & Services → Credentials** → Create credentials → OAuth client ID：
   - Application type: **Web application**（這個一定要選對，不然不會出現 redirect URI 欄位）
   - Authorized redirect URIs: `http://localhost:8765/api/calendar/oauth-callback`
   - Create 後跳出對話框 → 按「Download JSON」存檔
5. 把 client_id + client_secret 寫進 `services/dashboard_api/.env`：
   ```
   GOOGLE_OAUTH_CLIENT_ID=<你的-client-id>.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-<你的-client-secret>
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8765/api/calendar/oauth-callback
   ```

⚠️ OAuth 模式選擇：

| 模式 | 適用 | 限制 |
|---|---|---|
| **Testing**（預設、最簡單） | 開發 / 內部小團隊 | refresh token **7 天過期**；只有 Test users 名單能連結（最多 100 人） |
| **In production（未驗證）** | 小型實際使用 | 上限 100 人；每個使用者首次授權看到「未驗證」警告（點「進階」→「繼續」即可）；refresh token 不會 7 天過期 |
| **In production（已驗證）** | 公開上線 | 無人數限制、無警告 | 需向 Google 申請驗證（敏感 scope 通常 1-4 週審核） |

公司內部用 Testing 或 In production（未驗證）都夠用。Testing 模式記得加 Test users，否則授權會失敗。

### Step 5：安裝依賴

```bash
# Python 依賴
pip install httpx gspread google-api-python-client google-auth mcp

# Bun（如未安裝）
curl -fsSL https://bun.sh/install | bash

# Webhook channel 依賴
cd mcp && bun install && cd ..

# 確認腳本權限
chmod +x vexa.sh
chmod +x .claude/hooks/block-google-delete.sh

# 確認 cron 服務有在跑（WSL 預設未啟動）
sudo service cron start
# 確認 cron 狀態
sudo service cron status
# （選用）設定 WSL 啟動時自動執行 cron：在 /etc/wsl.conf 加入：
# [boot]
# command="service cron start"
```

### Step 6：Build 並啟動 Docker 服務

```bash
# 首次部署：一鍵 build + 啟動 + 初始化 DB + 建 API key
cd deploy/compose
make all-build
cd ../..
```

這會自動：
- Build 所有 Docker image（含 vexa-bot、api-gateway、meeting-api 等）
- 啟動所有服務
- 初始化 PostgreSQL schema
- 建立 dashboard 用的 API key

完成後確認服務狀態：
```bash
./vexa.sh status
```

> ℹ️ 日常重啟用 `./vexa.sh restart`，不需要重新 build。只有更新程式碼後才需要重新 `make build`。

### Step 7：確認 API Token

`make all-build` 已自動建立 API key 並寫入 `.env` 的 `VEXA_API_KEY`。確認它存在：

```bash
grep VEXA_API_KEY .env
```

如果需要手動重建 token：
```bash
./vexa.sh admin-up
curl -X POST "http://localhost:8057/admin/users/1/tokens?scopes=bot,tx" \
  -H "X-Admin-API-Key: <your-admin-token>"
# 把回傳的 token 填入 .env 的 VEXA_USER_API_KEY
./vexa.sh admin-down
```

### Step 8：註冊 MCP Server

在專案目錄下執行：
```bash
# 註冊 Vexa MCP server
claude mcp add vexa -s project -- python ./mcp/server.py

# 註冊 Webhook Channel
claude mcp add vexa-webhook -s project -e WEBHOOK_PORT=8901 -- bun ./mcp/webhook-channel.ts

# 確認註冊成功
claude mcp list
```

應該看到：
- `vexa: python ./mcp/server.py` → ✅ Connected
- `vexa-webhook: bun ./mcp/webhook-channel.ts` → ✅ Connected
- `claude.ai Google Drive` → ✅ Connected
- `claude.ai Google Calendar` → ✅ Connected

> ⚠️ 如果 `vexa-webhook` 顯示 Failed to connect，確認：`cd mcp && bun install && cd ..`，並確認 port 8901 沒有被佔用。

### Step 9：連接 Google MCP（Claude.ai）

1. 打開 [claude.ai](https://claude.ai)
2. 進入 Settings → Connected Apps
3. 連接 Google Drive、Google Calendar
4. 使用與 Service Account 同一 Google 帳號登入

### Step 10：啟動 Claude Code Agent

```bash
./vexa.sh agent
```

首次啟動會建立 session `noirsboxes-meeting-agent`，之後會自動 resume。

---

## 驗證部署

啟動後，在 TG 群組中逐步測試（所有訊息都要 **@你的bot名稱** 才會觸發）：

### 測試 1：基本連線
在 TG 群組發送：
```
@NoirsBoxesBot 你好，請確認目前狀態
```
✅ 預期結果：bot 回覆目前服務狀態（執行中的 bot 數量、最近會議等）

### 測試 2：加入會議
開一場測試 Google Meet，然後在 TG 群組發送：
```
@NoirsBoxesBot 請加入這場會議 https://meet.google.com/xxx-xxxx-xxx
```
✅ 預期結果：bot 回覆「已加入會議」，並在 Google Meet 中看到「NoirsBoxes 會議助理」參與者

### 測試 3：會議結束自動處理
在 Google Meet 中說幾句話（測試轉錄），然後結束會議。等待 1-3 分鐘。
✅ 預期結果：bot 自動在 TG 群組發送：
- 會議摘要（8-15 句）
- Action Items 清單
- Google Sheet 連結
- Google Doc 會議記錄連結

### 測試 4：查詢 Action Items
在 TG 群組發送：
```
@NoirsBoxesBot 請查看目前所有未完成的 Action Items
```
✅ 預期結果：bot 回覆剛才會議產生的 Action Items 清單

### 測試 5：跟催功能（選用）
在 TG 群組發送：
```
@NoirsBoxesBot 請設定每天早上 9 點跟催
```
✅ 預期結果：bot 回覆確認已設定定時跟催任務

> ℹ️ `@NoirsBoxesBot` 請替換為你在 @BotFather 建立的實際 bot 名稱。

---

## 常用指令

```bash
# 服務管理
./vexa.sh up                    # 啟動
./vexa.sh down                  # 關閉
./vexa.sh restart               # 重啟
./vexa.sh status                # 狀態
./vexa.sh logs                  # 所有 log
./vexa.sh logs meeting-api      # 指定服務 log

# Agent
./vexa.sh agent                 # 啟動 Claude Code Agent

# Admin（按需）
./vexa.sh admin-up              # 啟動 admin-api
./vexa.sh admin-down            # 關閉 admin-api

# 偵錯
docker ps --format "{{.Names}} {{.Status}}" | grep meeting-
cat mcp/webhook-channel.log
docker exec vexa-postgres-1 psql -U postgres -d vexa -c \
  "SELECT id, status, start_time FROM meetings ORDER BY created_at DESC LIMIT 5;"
```

---

## 認證方式一覽

| 用途 | 方式 | 位置 |
|---|---|---|
| Vexa API | API Token（bot+tx scope） | `.env` → `VEXA_USER_API_KEY` |
| Google Sheets/Docs | Service Account JSON | `credentials/google-service-account.json` |
| Google Drive/Calendar | Claude.ai Google MCP 連接 | Claude.ai Settings |
| Admin API | Admin Token | `.env` → `ADMIN_TOKEN` |
| Telegram | Bot Token | `.env` → `BOT_TOKEN` |

---

## 安全規則

- ❌ 不可刪除 Google Drive / Sheets / Calendar 上的任何資料
- ❌ `stop_bot` 需使用者明確要求才能執行
- ❌ 不在 TG 回覆中暴露內部資訊（chat_id、sheet_id、webhook URL 等）
- ✅ 可以新增檔案和資料夾
- ✅ 可以更新 Action Item 欄位內容
- ✅ 部門隔離：每個群組只能看到自己的資料

---

## 疑難排解

### `docker-compose: command not found`
新版 Docker 用 `docker compose`（空格），不是舊版的 `docker-compose`（連字號）。系統內的腳本已用 V2 語法，直接用 `make all-build` 或 `./vexa.sh` 即可。如果其他工具需要舊版指令：
```bash
echo 'alias docker-compose="docker compose"' >> ~/.bashrc && source ~/.bashrc
```

### Transcription token 過期（403）
`make all-build` 時出現 `TRANSCRIPTION_SERVICE_TOKEN rejected (403)`。
到 https://vexa.ai/account 取得新 token，更新 `.env` 的 `TRANSCRIPTION_SERVICE_TOKEN`，重新執行。

### Port 衝突
常用 port 清單：8056、8057、5458、6379、9000、9001、8901。檢查衝突：
```bash
for port in 8056 8057 5458 6379 9000 9001 8901; do
  ss -tlnp | grep -q ":$port " && echo "⚠️  Port $port 已佔用" || echo "✅ Port $port 可用"
done
```
大部分 port 可在 `.env` 中修改。

### Vexa API 回傳 401
通常是 `.env` 裡有兩個 token 互相衝突。`server.py` 優先讀 `VEXA_API_KEY`，其次才讀 `VEXA_USER_API_KEY`。
```bash
# 檢查有哪些 token
grep VEXA .env

# 驗證 token 是否有效
curl -s "http://localhost:8056/bots/status" \
  -H "X-API-Key: <你的token>"

# 如果 VEXA_API_KEY 是 make 自動產生的且無效，刪掉它
sed -i '/^VEXA_API_KEY=/d' .env
```
如果兩個都無效，重新建 token：
```bash
./vexa.sh admin-up
curl -s -X POST "http://localhost:8057/admin/users/1/tokens?scopes=bot,tx" \
  -H "X-Admin-API-Key: $(grep ADMIN_TOKEN .env | cut -d= -f2)" | python3 -m json.tool
# 把回傳的 token 填入 .env 的 VEXA_USER_API_KEY
./vexa.sh admin-down
```

### Bot container 啟動失敗（404 image not found）
`runtime-api` 報 `404 Client Error: Not Found` 表示 BROWSER_IMAGE tag 跟實際 build 出來的不一致。
```bash
# 查實際有哪些 image
docker images | grep vexa-bot

# 查 .env 指向哪個 tag
grep BROWSER_IMAGE .env
grep IMAGE_TAG .env

# 把 .env 更新成實際的 tag
sed -i 's/舊的tag/新的tag/g' .env

# 重要：修改 .env 後必須 down + up，不能只 restart
./vexa.sh down
./vexa.sh up

# 確認 runtime-api 讀到新的 image
docker exec vexa-runtime-api-1 env | grep BROWSER
```

### MCP `vexa` 沒出現在 `claude mcp list`
Python 依賴沒裝好。先手動測試：
```bash
python ./mcp/server.py
# 應該卡住等 stdin（正常），Ctrl+C 結束
# 如果報錯，補裝依賴：
pip install httpx gspread google-api-python-client google-auth mcp --break-system-packages
```
裝完後重新註冊：
```bash
claude mcp add vexa -s project -- python ./mcp/server.py
```

### MCP `vexa-webhook` Failed to connect
常見原因：port 8901 被舊 process 佔住。
```bash
# 查誰佔了 8901
ss -tlnp | grep 8901

# 如果是舊的 bun process，kill 它
ps -p <pid> -o pid,ppid,cmd    # 先確認是什麼
kill <pid>
```
如果是依賴沒裝：
```bash
cd mcp && bun install && cd ..
```
不需要手動 `claude mcp add vexa-webhook`，它已在 `.mcp.json` 中，`./vexa.sh agent` 啟動時會自動載入。

### MCP 路徑顯示絕對路徑（`/home/xxx/...`）
之前手動 `claude mcp add` 過導致全域設定覆蓋專案設定。清除後重新註冊：
```bash
claude mcp remove vexa --scope user
claude mcp add vexa -s project -- python ./mcp/server.py
```

### Google Service Account 憑證缺失
確認金鑰檔存在：
```bash
ls -la credentials/google-service-account.json
```
如果不存在，從 Google Cloud Console 下載並放到 `credentials/` 目錄。

### 修改 `.env` 後服務沒變化

Docker 服務不會自動重讀 `.env`，必須完整重啟：
```bash
./vexa.sh down
./vexa.sh up
```
MCP server 同理，修改 `.env` 後要重新註冊：
```bash
claude mcp remove vexa -s project
claude mcp add vexa -s project -- python ./mcp/server.py
```

### Webhook 收不到會議結束通知（Linux）
Linux Docker Engine 不會自動解析 `host.docker.internal`（Docker Desktop for Windows/Mac 會）。
docker-compose.yml 已加上 `extra_hosts: - "host.docker.internal:host-gateway"`。
如果更新後仍然失敗，確認：
```bash
# 從 container 內測試連線
docker exec vexa-meeting-api-1 curl -s http://host.docker.internal:8901/health

# 如果仍失敗，改用實際 IP
ip route show default | awk '{print $3}'  # 取得 gateway IP
# 把 .env 的 POST_MEETING_HOOKS 改成 http://<gateway-ip>:8901/hooks/meeting-completed
```
