import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Vite + React for NoirsBoxes Dashboard.
// dashboard_api 跑在 :8765；frontend 跑在 :5173。
// 用 proxy 把 /api/* 轉去後端，cookie 因為 same origin 自然會帶上，不需要 CORS。
//
// Bind host 由 env DASHBOARD_HOST 控制：
//   - 預設 127.0.0.1（local only，公司內部用）
//   - 0.0.0.0 才會讓同 LAN 的裝置可連
// 切換用 `make local` / `make lan`，會同步改 dashboard_web/.env 和 dashboard_api/.env。
//
// loadEnv 會載入 .env / .env.local（不限定 VITE_ prefix，第四參數 '' 表示載入所有）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.DASHBOARD_HOST ?? '127.0.0.1';

  return {
    plugins: [react()],
    server: {
      host,
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8765',
          changeOrigin: false,
        },
      },
    },
  };
});
