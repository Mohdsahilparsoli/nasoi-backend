import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { clientIp, errorHandler, notFound } from "./lib/http.js";
import { CLIENT_HEADER, csrfGuard, securityHeaders } from "./middleware/security.js";
import { authRouter } from "./modules/auth/routes.js";
import { documentsRouter, profileRouter } from "./modules/profile/routes.js";
import { registrationRouter } from "./modules/registration/routes.js";

export function createApp() {
  const c = config();
  const app = express();

  app.disable("x-powered-by");
  // Behind Vercel's proxy: trust exactly one hop for the client IP.
  app.set("trust proxy", 1);

  app.use(securityHeaders);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || c.corsOrigins.includes(origin.replace(/\/$/, ""))),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", CLIENT_HEADER],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "20kb" }));
  app.use(cookieParser());

  app.get("/", (_req, res) => res.json({ name: "NASOI API", version: "v1", docs: "/api/v1/health" }));
  app.get("/api/v1/health", async (_req, res) => {
    let database = "down";
    try {
      await prisma().$queryRaw`select 1`;
      database = "up";
    } catch (err) {
      console.error("[health] db check failed", (err as Error).message);
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(database === "up" ? 200 : 503).json({ status: database === "up" ? "ok" : "degraded", database, time: new Date().toISOString(), clientIp: clientIp(_req) });
  });

  app.use("/api/v1", csrfGuard);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/registrations", registrationRouter);
  app.use("/api/v1/profile", profileRouter);
  app.use("/api/v1/documents", documentsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
