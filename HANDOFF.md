# NoirsBoxes 會議助理 — 使用與交接指南

> 本文件說明系統「怎麼用」（操作流程）。部署 / 安裝請見 `README.md`，AI 行為規則請見 `CLAUDE.md`。
> 最後更新：2026-05-20

---

## 0. 系統是什麼

NoirsBoxes 會議助理把「開會 → 產出會議記錄 + Action Items → 追蹤 / 跟催」整條流程自動化。兩個操作介面：

- **Telegram Bot**（`@hec_meeting_bot`）：在部門群組裡下指令（加入會議、查狀態、設跟催），會議結束自動發摘要
- **Dashboard 網頁**（公司內網 `http://<主機IP>:5173`）：視覺化看會議記錄、Action Items、報表、月曆；也能本地錄音

背後有 6 個常駐 process（細節見 README「本地服務」「Docker 服務」表）：
Vexa stack（Docker）、speaches（本地 Whisper）、dashboard_api、dashboard_web、webhook-channel、calendar-poller。

---

## 1. 初次使用

### 1-1. 啟動系統
```bash
cd /home/user/Agents/meeting_agent
./vexa.sh up          # 啟動全部（Vexa + speaches + dashboard + webhook + calendar-poller）
./vexa.sh agent       # 啟動 Claude Code agent（接 TG / webhook）
./vexa.sh status      # 確認所有服務都 ✓
```

### 1-2. 新增第一個部門（重要）

> ⚠️ 一個「部門」= 一個 TG 群組 + 一組 Dashboard 登入帳號。兩邊都要建立才算完整。
> 自 2026-05-20 起，**從 Dashboard Admin 建立部門會一次寫好兩邊**（nb_departments DB + config/departments.json + 本地 records 資料夾），單一入口。

步驟：
1. 瀏覽器開 `http://<主機IP>:5173/admin/login`，用 admin 密碼登入
2. 進「部門管理」→「新增部門」，填：
   - **部門名稱**（例：生管部門）
   - **slug**（登入用代號，小寫英數，例：production）
   - **password**（該部門 Dashboard 登入密碼，至少 6 字）
   - **chat_id**（該部門 TG 群組的 chat_id，見下方「怎麼拿 chat_id」）
   - sheet_id / drive_folder_id 留空（歷史欄位，現流程不用）
3. 送出 → 系統自動：
   - 寫 `nb_departments`（Dashboard 登入用）
   - 寫 `config/departments.json`（TG / 會議流程部門查找用）
   - 建 `records/<部門名稱>/` 資料夾（本地會議記錄存放）

#### 怎麼拿 TG 群組 chat_id
1. 把 `@hec_meeting_bot` 加進該部門 TG 群組
2. 在群組裡 @bot 發任意訊息
3. Bot 收到後，從訊息的 chat_id 即可得知（負責的工程師可從 Claude session log 或請 bot 回報）

> 舊流程（仍可用）：在 TG 群組裡 @bot「我們是 XXX 部門」→ bot 用 `add_department` 寫 config，但**不會**設 Dashboard 登入帳密。建議一律走 Dashboard Admin 新增（單一入口、不漏步驟）。

### 1-3. 改掉預設密碼
首次部署的預設密碼（**務必改掉**）：

| 角色 | 入口 | 預設密碼 |
|---|---|---|
| 各部門 | `/login`（用 slug） | `changeme123` |
| 管理員 | `/admin/login` | `admin123` |

到 Admin 介面逐一改。

### 1-4. Google Cloud 設定（月曆 / 自動加入會議功能用）

#### 為什麼需要 Google Cloud

「月曆」分頁與「會議自動加入」功能需要讀取使用者的 Google Calendar，這只能透過 **Google Calendar API + OAuth 2.0** 取得。OAuth 一定要先在 Google Cloud Console 建立一個專案 + 一組 OAuth Client，使用者才能在 Dashboard 點「連結 Google 行事曆」授權給系統。

> 注意：**只有 Calendar 需要 Google Cloud**。自 2026-05-19 起 Drive / Sheets / Docs 已從流程移除，不需要設定那些 API，也不需要 Service Account。

「申請 API」聽起來複雜，但 Calendar API 是**免費、不用付費、不用送審額度**。整個設定約 10-15 分鐘。

#### 需要設定的地方（GCP Console）

1. **建立 / 選擇專案**
   - https://console.cloud.google.com/ → 用公司 Google 帳號登入 → 建新專案（或用既有的）

2. **啟用 Google Calendar API**
   - APIs & Services → Library → 搜「Google Calendar API」→ Enable

3. **OAuth 同意畫面（OAuth consent screen）**
   - User Type：**External**（gmail / workspace 帳號都能授權）
   - 新版 UI 可能拆成 Branding / Audience / Data access / Clients 幾個 tab：
     - **Branding**：填 App name、User support email、Developer contact
     - **Data access / Scopes**：加 5 個 scope（缺了 email 那幾個會導致連結失敗 `no_email`）：
       - `openid`
       - `https://www.googleapis.com/auth/userinfo.email`
       - `https://www.googleapis.com/auth/userinfo.profile`
       - `https://www.googleapis.com/auth/calendar.readonly`
       - `https://www.googleapis.com/auth/calendar.events.readonly`
     - **Audience / Test users**：把要連結的 Google email 加進去（Testing 模式只有名單內能授權，最多 100 人）

4. **建立 OAuth Client ID**
   - Credentials → Create credentials → OAuth client ID
   - Application type：**Web application**（一定要選這個，不然不會出現 redirect URI 欄位）
   - Authorized redirect URIs：`http://localhost:8765/api/calendar/oauth-callback`
   - 建好後拿到 client_id + client_secret

5. **填進 dashboard_api 的 `.env`**
   ```
   GOOGLE_OAUTH_CLIENT_ID=<你的-client-id>.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-<你的-client-secret>
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8765/api/calendar/oauth-callback
   ```
   重啟 dashboard_api 生效。

#### OAuth 模式選擇

| 模式 | 適用 | 限制 |
|---|---|---|
| **Testing**（最簡單） | 開發 / 內部小團隊 | refresh token **7 天過期**（要定期重連）；只有 Test users 名單能連結 |
| **In production（未驗證）** | 小型實際使用 | 上限 100 人；每人首次授權看到「未驗證」警告（點「進階 → 繼續」即可）；token 不會 7 天過期 |
| **In production（已驗證）** | 公開上線 | 無限人數、無警告；需送 Google 審查（敏感 scope 約 1-4 週） |

公司內部用 Testing 或 In production（未驗證）都夠。

> ⚠️ redirect URI 限制：Google 只接受 `http://localhost:PORT/*` 或 `https://網域/*`，**不接受公網 IP**（`http://192.168.x.x` 不行）。所以「連結行事曆」這個動作要在主機本機瀏覽器或 AnyDesk 進主機後操作。

---

## 2. 日常功能

### 2-1. Telegram Bot 指令（在部門群組 @bot）

| 你說 | Bot 做什麼 |
|---|---|
| 加入 https://meet.google.com/xxx-xxxx-xxx | 派 bot 進會議錄音 + 發 recap（上次重點 + 未完成 AI）|
| bot 在嗎 / 查狀態 | 回報目前進行中 / 等待加入的 bot |
| 讓 bot 退出會議 | 停止指定 bot（**只有明確要求才會停**）|
| 查 Action Items | 回報該部門未完成項目（依負責人分組）|
| 設每天 9 點跟催 | 建立 / 修改跟催 cron |
| 停掉跟催 | 刪除跟催 cron |

> 會議結束後 bot 自動：產生議題式摘要 + Action Items → 寫 DB + 本地 markdown → 發摘要到群組（附 Excel）。不需要任何指令。

### 2-2. Dashboard 網頁分頁

進 `http://<主機IP>:5173`，用部門 slug + 密碼登入：

| 分頁 | 功能 |
|---|---|
| **總覽**（首頁） | 跟催警示卡（逾期 / 即將到期，點擊展開）+ 最近 3 場會議 + Action Items 完整清單（可直接改狀態 / 編輯）|
| **會議記錄** | 所有會議列表 + 點進去看摘要 / Action Items / 完整逐字稿 |
| **Action Items** | 三欄看板（未開始 / 進行中 / 已完成），依負責人分組，可編輯、匯出 Excel |
| **本地錄音** | 不靠 Google Meet 直接錄音 / 上傳音檔 → 自動轉錄 + 摘要 |
| **月曆** | 連結 Google 行事曆、看事件、自動加入有 Meet 連結的會議 |
| **報表** | 週報 / 月報 |

### 2-3. 會議自動加入（月曆）

1. 月曆分頁 → 「連結 Google 行事曆」→ Google 授權（首次會看到「未驗證」警告，點「進階 → 繼續」）
2. 連結後，背景 `calendar-poller` 每分鐘掃描：
   - 會議前 **5 分鐘** → 發提醒到部門群組
   - 會議前 **1 分鐘** → 自動派 bot 加入（含 recap）
3. 不需要手動加入。會議結束照常自動摘要。

### 2-4. 本地錄音 / 上傳音檔

面對面開會、不用 Google Meet 時：
1. Dashboard「本地錄音」分頁
2. 選「即時錄音」（瀏覽器麥克風）或「上傳音檔」（選現成 webm/mp3/m4a 檔）
3. 上傳後 speaches 轉錄（音檔越長等越久）→ 自動產出摘要 + Action Items → Dashboard 顯示 + TG 通知

> ⚠️ 即時錄音需要瀏覽器有麥克風權限（HTTPS 或 localhost）。AnyDesk 遠端 + 無實體麥克風時用「上傳音檔」較可靠。

### 2-5. 跟催 / 週報 / 月報（自動）

- **每日跟催**（預設早上觸發）：列出逾期 + 即將到期的 Action Items，tag 負責人發到群組。沒有要跟催的就靜默。
- **週報**（每週一）/ **月報**（每月 1 號）：自動彙整該期間會議 + Action Items，存進報表分頁，DM 給管理員。

時間調整：在 TG 群組跟 bot 說「跟催改成早上 8 點」之類即可。

---

## 3. 維運

### 3-1. 服務管理
```bash
./vexa.sh status              # 看所有服務狀態 + PID
./vexa.sh restart             # 全部重啟
./vexa.sh dashboard-down && ./vexa.sh dashboard-up   # 只重啟 dashboard
./vexa.sh calendar-poller-up  # 單獨啟 calendar-poller
```

### 3-2. Log 位置
| 服務 | Log |
|---|---|
| dashboard_api | `/tmp/dashboard_api.log` |
| dashboard_web | `/tmp/dashboard_web.log` |
| calendar-poller | `/tmp/calendar_poller.log` |
| webhook-channel | `mcp/webhook-channel.log` |

### 3-3. 改了程式碼後怎麼生效（重要踩雷區）
| 改了什麼 | 怎麼生效 |
|---|---|
| dashboard_web（前端） | Vite 自動 hot-reload，瀏覽器重整即可 |
| dashboard_api（後端） | **手動重啟**：`./vexa.sh dashboard-down && ./vexa.sh dashboard-up`（沒有 --watch）|
| mcp/server.py、mcp/webhook-channel.ts | **完整重啟 Claude session**（`/reload-plugins` 不夠 — 那只重載 plugin-scope MCP，這兩個是 project-scope）|
| CLAUDE.md | 下次 session 自動生效 |

### 3-4. 已知踩雷點（給工程師）
1. **channel notification 的 meta 必須全部是字串** — 放 number / boolean 會被 Claude Code 的 channel handler 靜默吞掉整則通知（debug 超痛）。歷史上 `attendees_count` 跟 `duration` 都踩過。
2. **webhook-channel.ts 的 DB 連線 port 是 5458**（跟 Vexa 同 DB），不要誤改成別的。
3. **重啟 dashboard_api 會殺掉進行中的本地錄音轉錄**（async IIFE 等 speaches 時被 kill）→ 確認沒人在上傳時才重啟。
4. **部門歸屬唯一來源 = `nb_meetings.department_id`**（派發時寫入），不要用 `config/meeting_map.json` 反查（已 deprecated）。

---

## 4. 資料存哪

| 資料 | 位置 |
|---|---|
| 會議 / Action Items / 報表 / 部門 / Calendar 帳號 | PostgreSQL `nb_*` tables（跟 Vexa 同 DB，port 5458）|
| 完整逐字稿 + 會議記錄 markdown | `records/<部門>/MMDD_<標題>_<meet_id>.md` |
| 部門 → TG chat_id 對應 | `config/departments.json` |
| OAuth / Bot token / 密鑰 | `.env`（不進 git）|

> ⚠️ 自 2026-05-19 起，**不再寫入 Google Drive / Sheets / Doc**。歷史檔案保留供查閱但不再同步。MCP 工具仍註冊但流程不呼叫。
