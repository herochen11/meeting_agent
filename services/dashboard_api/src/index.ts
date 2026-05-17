import { Hono } from "hono";
import { logger } from "hono/logger";
import { healthRoute } from "./routes/health";
import { authRoute } from "./routes/auth";
import { actionItemsRoute } from "./routes/action-items";
import { meetingsRoute } from "./routes/meetings";
import { botRoute } from "./routes/bot";
import { adminRoute } from "./routes/admin";

const app = new Hono();

app.use("*", logger());

app.route("/", healthRoute);
app.route("/", authRoute);
app.route("/", actionItemsRoute);
app.route("/", meetingsRoute);
app.route("/", botRoute);
app.route("/", adminRoute);

app.notFound((c) => c.json({ error: "找不到此路徑" }, 404));

app.onError((err, c) => {
  console.error("[未處理錯誤]", err);
  return c.json({ error: "伺服器內部錯誤" }, 500);
});

const port = Number.parseInt(process.env.PORT ?? "8765", 10);
const hostname = process.env.HOST ?? "127.0.0.1"; // localhost only by default (公司內部用)

console.log(`[dashboard-api] 啟動中，listening on ${hostname}:${port}`);

export default {
  port,
  hostname,
  fetch: app.fetch,
};
