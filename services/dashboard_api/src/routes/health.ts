import { Hono } from "hono";
import { ping } from "../db";

export const healthRoute = new Hono();

healthRoute.get("/health", async (c) => {
  const dbOk = await ping();
  return c.json({
    status: "ok",
    db: dbOk ? "ok" : "down",
    ts: new Date().toISOString(),
  });
});
