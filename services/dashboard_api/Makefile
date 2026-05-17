.PHONY: install dev start test local lan

install:
	bun install

dev:
	bun run dev

start:
	bun run start

test:
	bun test

# ─── Bind host 切換 ────────────────────────────────────────────────
# 改 .env 內的 HOST 然後使用者重啟 bun。
# bun 啟動時讀 .env，要重啟才會生效。

local:
	@sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env
	@echo "[dashboard_api] HOST=127.0.0.1 (local only) — 重啟 bun 後生效"

lan:
	@sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env
	@echo "[dashboard_api] HOST=0.0.0.0 (LAN bind) — 重啟 bun 後生效"
