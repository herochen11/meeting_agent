# NoirsBoxes AI 會議助理（T3）

AI 參與 Google Meet 會議，自動產出會議記錄與行動清單，追蹤進度與自動跟催。

> 📖 日常使用方法（操作流程、Dashboard 分頁、TG 指令）見 `HANDOFF.md`；本文件聚焦部署 / 安裝。

## 系統架構

```
TG 群組訊息
    ↓ Claude Code Channels（telegram plugin）
Claude Code Session（WSL）
    ↓ 透過 MCP tools
    ├── Vexa MCP → 加入會議 / 查狀態 / 取逐字稿 / summarize
    ├── Google Calendar MCP（唯讀）→ 讀取行事曆排程
    └── 寫入：nb_meetings + nb_action_items DB + 本地 markdown（records/<部門>/）

會議結束
    ↓ meeting-api POST http://host.docker.internal:8901/hooks/meeting-completed
    ↓ webhook-channel.ts（Bun，port 8901）接收
    ↓ 推 channel notification 給 Claude Code session
    ↓ Claude 自動：summarize → 寫 DB + 本地 markdown → 發 TG（附 Excel）

行事曆自動加入（獨立流程）
    ↓ calendar-poller（Bun，每 1 分鐘輪詢 nb_calendar_accounts）
    ↓ POST http://localhost:8901/hooks/calendar-upcoming
    ↓ webhook-channel.ts 推 channel notification 給 Claude Code session
    ↓ Claude 判斷 phase：T-5 發提醒到群組 / T-1 派 bot 加入會議（內建 recap）
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
│       └── block-google-delete.sh     ← PreToolUse hook 防止誤刪資料
├── config/
│   ├── departments.json               ← 部門 + 人員對應表（不進 git）
│   └── departments.example.json       ← 對應表範本
├── mcp/
│   ├── server.py                      ← MCP server（所有 tools）
│   └── webhook-channel.ts             ← 會議結束通知 + 跟催觸發 + 行事曆事件通知
├── deploy/compose/
│   └── docker-compose.yml             ← Vexa 0.10.6 Docker Compose
└── services/
    ├── dashboard_api/                 ← Dashboard 後端（Bun + Hono）
    ├── dashboard_web/                 ← Dashboard 前端（Vite + React）
    ├── calendar-poller/               ← Google Calendar 輪詢服務
    ├── vexa-bot/                      ← Bot 原始碼
    ├── meeting-api/                   ← 會議管理 API
    ├── runtime-api/                   ← Docker container 管理
    └── api-gateway/                   ← API 入口
```

## MCP Tools 清單

| 分類 | Tool | 說明 |
|---|---|---|
| Vexa | `join_meeting` | 送 bot 進 Google Meet |
| Vexa | `stop_bot` | 停止 bot（需手動確認） |
| Vexa | `get_status` | 查詢 bot 狀態 |
| Vexa | `get_meetings` | 列出最近會議 |
| Vexa | `get_transcript` | 取得逐字稿 |
| Vexa | `summarize_meeting` | 讀取逐字稿準備摘要 |
| Action Items | `append_action_items` | 新增 Action Items（寫入 DB） |
| Action Items | `update_action_item` | 更新單一 Action Item 欄位 |
| Action Items | `get_action_items` | 讀取 Action Items（可篩選） |
| Cron | `set_cron` | 建立/更新定時任務 |
| Cron | `list_crons` | 列出所有定時任務 |
| Cron | `delete_cron` | 刪除定時任務 |
| Config | `get_config` | 讀取部門 + 人員對應表 |
| Config | `add_department` | 新增部門 |
| Config | `update_member` | 更新人員 TG Username / 逐字稿名字 |

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
| speaches | 8020 | 本地 Whisper 語音轉錄（GPU） |
| dashboard_api | 8765 | Dashboard 後端 API（Bun + Hono） |
| dashboard_web | 5173 | Dashboard 前端（Vite + React） |
| webhook-channel | 8901 | 會議結束通知 + 跟催觸發 + 行事曆事件通知 |
| calendar-poller | — | 每分鐘輪詢 Google Calendar，發現 Meet 連結自動派 bot |

---

# Dashboard

公司內部使用的網頁介面：

- 📋 Action Items 看板（依負責人 / 狀態分組、可編輯）
- 🎙️ 會議記錄瀏覽（含摘要、Action Items、逐字稿）
- 🤖 Bot 控制台（即時查看狀態、派發 / 停止 bot）
- 🔐 部門權限隔離 + 管理員後台

## 啟動方式

Dashboard 已整合到 `vexa.sh`：

```bash
./vexa.sh up        # 啟動全部（Vexa + speaches + dashboard + webhook + calendar-poller）
./vexa.sh down      # 全部關閉
./vexa.sh status    # 查看所有服務狀態
./vexa.sh restart   # 全部重啟
```

也可以單獨管理：

```bash
./vexa.sh dashboard-up    # 只啟動 dashboard（api + web）
./vexa.sh dashboard-down  # 只關閉 dashboard
```

## 開啟網頁

啟動後在瀏覽器開：

```
http://localhost:5173
```

## 預設帳密

| 角色 | Slug / 入口 | 預設密碼 |
|---|---|---|
| 生管部門 | `production` | `changeme123` |
| 測試群 | `test` | `changeme123` |
| 測試2群 | `test2` | `changeme123` |
| 管理員 | `/admin/login` | `admin123` |

> ⚠️ **務必透過 Admin 介面儘早改掉所有預設密碼。**

## 內網存取

預設只能本機連線。要讓同公司其他電腦也能用：

```bash
# 切換到 LAN 模式
cd services/dashboard_api && make lan
cd services/dashboard_web && make lan
```

切換後公司其他電腦可用 `http://<這台機器的 IP>:5173` 連線。

## 服務細節

| 元件 | Port | Log 位置 |
|---|---|---|
| dashboard_api | 8765 | `/tmp/dashboard_api.log` |
| dashboard_web | 5173 | `/tmp/dashboard_web.log` |

## 常見問題

**Q：登入後出現「請先登入」**
A：Cookie 沒帶上。確認瀏覽器允許 cookie，或 incognito 試試。

**Q：Bot 控制台顯示「Vexa 無法連線」**
A：Vexa 服務沒起來，跑 `./vexa.sh status` 確認。

**Q：改了 .env 沒生效**
A：dashboard_api 不自動 reload，要 `./vexa.sh dashboard-down && ./vexa.sh dashboard-up`。

---

# 部署指南

## 環境需求

- **作業系統**：Windows + WSL2（Ubuntu 24）或原生 Linux
- **Docker**：Docker Desktop（Windows）或 Docker Engine（Linux），需支援 compose v2
- **Python**：3.10+
- **Bun**：用於 webhook-channel.ts 和 Dashboard
- **Claude Code**：需安裝且有 Anthropic 存取權限
- **Cron**：用於每日跟催定時任務（WSL 預設未啟用，需手動開啟）
- **NVIDIA GPU**：用於本地 Whisper 語音轉錄（建議 RTX 4060 以上，8GB VRAM）
- **Google 帳號**：用於 Google Calendar OAuth（自動加入會議）

## 部署步驟

### Step 1：Clone 專案

```bash
git clone <repo-url>
cd meeting_agent
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

### Step 3：設定 Google Calendar OAuth（Dashboard 月曆 + 自動加入）

1. 進 https://console.cloud.google.com/，建立新專案
2. **APIs & Services → Library** → 搜「Google Calendar API」→ Enable
3. **APIs & Services → OAuth consent screen**：
   - User Type：選 **External**
   - 填 App name、Email
   - Scopes：加 `calendar.readonly` 和 `calendar.events.readonly`
   - Test users：加入要連結的 Google email
4. **APIs & Services → Credentials** → Create credentials → OAuth client ID：
   - Application type：**Web application**
   - Authorized redirect URIs：`http://localhost:8765/api/calendar/oauth-callback`
   - 下載 JSON
5. 寫入 `services/dashboard_api/.env`：
   ```
   GOOGLE_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-<your-secret>
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8765/api/calendar/oauth-callback
   ```

### Step 4：建立部門對應表

```bash
cp config/departments.example.json config/departments.json
```

部門資料透過 Dashboard Admin 介面或 TG 指令建立，初始保持空白即可。

### Step 5：安裝依賴

```bash
# Python 依賴
pip install httpx gspread google-api-python-client google-auth mcp psycopg2-binary

# Bun（如未安裝）
curl -fsSL https://bun.sh/install | bash

# Webhook channel 依賴
cd mcp && bun install && cd ..

# Dashboard 依賴
cd services/dashboard_api && bun install && cd ../..
cd services/dashboard_web && bun install && cd ../..

# 確認腳本權限
chmod +x vexa.sh
chmod +x .claude/hooks/block-google-delete.sh

# 確認 cron 服務有在跑（WSL 預設未啟動）
sudo service cron start
```

### Step 6：Build 並啟動 Docker 服務

```bash
cd deploy/compose
make all-build
cd ../..
```

確認服務狀態：
```bash
./vexa.sh status
```

### Step 7：確認 API Token

```bash
grep VEXA_API_KEY .env
```

如果需要手動重建 token：
```bash
./vexa.sh admin-up
curl -s -X POST "http://localhost:8057/admin/users/1/tokens?scopes=bot,tx" \
  -H "X-Admin-API-Key: $(grep ADMIN_TOKEN .env | cut -d= -f2)" | python3 -m json.tool
# 把回傳的 token 填入 .env 的 VEXA_USER_API_KEY
./vexa.sh admin-down
```

### Step 8：註冊 MCP Server

```bash
claude mcp add vexa -s project -- python ./mcp/server.py
claude mcp add vexa-webhook -s project -e WEBHOOK_PORT=8901 -- bun ./mcp/webhook-channel.ts
claude mcp list
```

### Step 9：連接 Google Calendar MCP（Claude.ai）

1. 打開 [claude.ai](https://claude.ai)
2. Settings → Connected Apps → 連接 Google Calendar

### Step 10：啟動

```bash
./vexa.sh up      # 啟動所有服務
./vexa.sh agent   # 啟動 Claude Code Agent
```

---

## 驗證部署

在 TG 群組中逐步測試（訊息要 **@你的bot名稱** 才會觸發）：

### 測試 1：基本連線
```
@Bot 你好，請確認目前狀態
```
✅ bot 回覆服務狀態

### 測試 2：加入會議
```
@Bot 請加入這場會議 https://meet.google.com/xxx-xxxx-xxx
```
✅ bot 加入 Google Meet

### 測試 3：會議結束自動處理
結束會議，等 1-3 分鐘。
✅ bot 自動發送摘要 + Action Items + Excel 附件

### 測試 4：查詢 Action Items
```
@Bot 請查看目前所有未完成的 Action Items
```
✅ bot 回覆 Action Items 清單

### 測試 5：跟催（選用）
```
@Bot 請設定每天早上 9 點跟催
```
✅ bot 確認已設定

---

## 常用指令

```bash
./vexa.sh up                    # 啟動全部
./vexa.sh down                  # 關閉全部
./vexa.sh restart               # 重啟
./vexa.sh status                # 狀態
./vexa.sh agent                 # 啟動 Claude Code Agent
./vexa.sh dashboard-up          # 只啟動 Dashboard
./vexa.sh dashboard-down        # 只關閉 Dashboard
./vexa.sh admin-up              # 啟動 admin-api（按需）
./vexa.sh admin-down            # 關閉 admin-api
```

---

## 認證方式一覽

| 用途 | 方式 | 位置 |
|---|---|---|
| Vexa API | API Token（bot+tx scope） | `.env` → `VEXA_USER_API_KEY` |
| Google Calendar（Dashboard） | OAuth 2.0 | `services/dashboard_api/.env` |
| Google Calendar（Claude session） | Claude.ai MCP 連接 | Claude.ai Settings |
| Admin API | Admin Token | `.env` → `ADMIN_TOKEN` |
| Telegram | Bot Token | `.env` → `BOT_TOKEN` |

---

## 安全規則

- ❌ 不可刪除使用者資料（DB、本地 markdown）
- ❌ `stop_bot` 需使用者明確要求才能執行
- ❌ 不在 TG 回覆中暴露內部資訊
- ✅ 可以新增檔案和資料夾
- ✅ 可以更新 Action Item 欄位內容
- ✅ 部門隔離：每個群組只能看到自己的資料

---

## 疑難排解

### `docker-compose: command not found`
新版 Docker 用 `docker compose`（空格）。直接用 `./vexa.sh` 即可。

### Transcription token 過期（403）
到 https://vexa.ai/account 取得新 token，更新 `.env` 的 `TRANSCRIPTION_SERVICE_TOKEN`。

### Port 衝突
```bash
for port in 8056 8057 5458 6379 9000 9001 8901 8765 5173 8020; do
  ss -tlnp | grep -q ":$port " && echo "⚠️  Port $port 已佔用" || echo "✅ Port $port 可用"
done
```

### Vexa API 回傳 401
```bash
grep VEXA .env
curl -s "http://localhost:8056/bots/status" -H "X-API-Key: <你的token>"
```
如果 `VEXA_API_KEY` 無效：`sed -i '/^VEXA_API_KEY=/d' .env`

### Bot container 啟動失敗（404）
```bash
docker images | grep vexa-bot        # 查實際 tag
grep BROWSER_IMAGE .env              # 查 .env 的 tag
# 改成一致後：
./vexa.sh down && ./vexa.sh up
```

### MCP 連線問題
```bash
# vexa 沒出現：測試 Python
python ./mcp/server.py               # 卡住=正常，報錯=裝依賴

# webhook 連不上：查 port
ss -tlnp | grep 8901                 # 被佔就 kill
cd mcp && bun install && cd ..       # 缺依賴就裝
```

### Webhook 收不到通知（Linux）
```bash
docker exec vexa-meeting-api-1 python -c "
import socket
print(socket.gethostbyname('host.docker.internal'))
"
```
如果 DNS 失敗，確認 `docker-compose.yml` 有 `extra_hosts: - "host.docker.internal:host-gateway"`，然後 `./vexa.sh down && ./vexa.sh up`。

### 修改 .env 後沒生效
```bash
./vexa.sh down && ./vexa.sh up       # Docker 服務
claude mcp remove vexa -s project    # MCP
claude mcp add vexa -s project -- python ./mcp/server.py
```
