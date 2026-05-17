.PHONY: install dev build preview clean local lan

install:
	npm install

dev:
	npm run dev

build:
	npm run build

preview:
	npm run preview

clean:
	rm -rf node_modules dist

# ─── Bind host 切換 ────────────────────────────────────────────────
# 改 .env 內的 DASHBOARD_HOST。Vite 會偵測 .env 變化自動 restart dev server。

local:
	@sed -i 's/^DASHBOARD_HOST=.*/DASHBOARD_HOST=127.0.0.1/' .env
	@echo "[dashboard_web] DASHBOARD_HOST=127.0.0.1 (local only) — vite 自動 restart"

lan:
	@sed -i 's/^DASHBOARD_HOST=.*/DASHBOARD_HOST=0.0.0.0/' .env
	@echo "[dashboard_web] DASHBOARD_HOST=0.0.0.0 (LAN bind) — vite 自動 restart"
