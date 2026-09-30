// Vercel entrypoint: the Express app is exported and run as a Vercel Function.
import express from "express";
import { createApp } from "./app.js";

function build() {
  try {
    return createApp();
  } catch (err) {
    // Missing/invalid env vars: answer 503 instead of crashing, and log which keys are wrong (never values).
    console.error("[boot]", (err as Error).message);
    const fallback = express();
    fallback.disable("x-powered-by");
    fallback.use((_req, res) =>
      res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Server is not configured yet. Check environment variables." } }),
    );
    return fallback;
  }
}

const app = build();
export default app;
