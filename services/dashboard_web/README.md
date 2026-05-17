# dashboard_web

NoirsBoxes Dashboard 前端 — Vite + React 18 + TypeScript + Tailwind v3 + TanStack Query v5。

## 開發

```bash
make install   # 或 npm install
make dev       # 啟動 :5173
```

開 http://localhost:5173/login，用部門帳號（如 `production` / `changeme123`）登入。

## 架構

- `/api/*` 透過 Vite proxy 轉到 `localhost:8765`（dashboard_api），cookie 同 origin 自動帶上，**不需要 CORS**。
- 路由
  - `/login`、`/admin/login`
  - `/`（會議列表）、`/meetings/:id`、`/action-items`
  - `/admin/departments`
- 認證
  - HttpOnly cookie 由後端 `dashboard_api` 簽發。
  - `localStorage` 只存 UI 提示用的部門名稱，不存 token。

## 樣式

Tailwind v3 utility-first。`slate / blue` 為主色，負責人 chip 依名字 hash 配色。

## 後端

啟動指令在 `services/dashboard_api/` 下 `bun run dev`，預設 :8765。

## Bind host：localhost vs LAN

兩邊預設都綁 `127.0.0.1`（local only，公司內部用，最安全）。需要讓同 LAN 的手機/平板連時切換成 `0.0.0.0`：

```bash
# 在 services/dashboard_web/ 切前端 bind
make local   # DASHBOARD_HOST=127.0.0.1
make lan     # DASHBOARD_HOST=0.0.0.0

# 在 services/dashboard_api/ 切後端 bind
make local   # HOST=127.0.0.1
make lan     # HOST=0.0.0.0
```

兩個 target 都只改各自的 `.env`：
- Vite dev server 會偵測 `.env` 變化自動 restart（馬上生效）。
- bun 啟動時讀 `.env`，如果後端正在跑要手動 `Ctrl+C` 後重跑 `make dev`。

驗證：
```bash
ss -ltnp | grep -E ':(5173|8765)'
```

