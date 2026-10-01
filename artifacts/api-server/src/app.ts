import path from "node:path";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import { restoreReadOnlyRequests } from "./lib/restore-mode";

const app: Express = express();

// Production runs behind one trusted reverse-proxy hop (Fly, Replit, or the
// operator's ingress), so req.ip reflects the client without trusting an
// arbitrary forwarded chain.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(restoreReadOnlyRequests);
// The portable object-store adapter accepts a signed, short-lived raw PUT.
// This must run before the general JSON parser so image bytes are preserved.
app.use(
  "/api/v1/public/uploads/local",
  express.raw({ type: () => true, limit: "10mb" }),
);
// Voice-note transcription posts base64 audio (up to ~5MB raw, ~7MB as
// base64 JSON); everything else keeps the conservative default limit.
app.use(
  "/api/v1/public/concierge/transcriptions",
  express.json({ limit: "8mb" }),
);
// CSV lead imports post the raw file contents as a JSON string (up to 5MB
// of CSV, ~6MB with JSON escaping); the route re-enforces the 5MB CSV cap.
app.use("/api/v1/lead-imports", express.json({ limit: "8mb" }));
// Evidence Intelligence accepts an explicitly approved artifact as base64 JSON.
// The route itself enforces a 5MB raw cap and a strict MIME allowlist.
app.use("/api/v1/bie/claims", express.json({ limit: "8mb" }));
// Keep the raw body around for webhook signature verification (Resend/svix
// signs the exact bytes, not the re-serialized JSON).
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.use("/api", router);

// Single-container production: serve the built SPA from the same origin as the
// API, so relative /api/* calls just work with no proxy. In dev the SPA is
// served by Vite, so this only runs when NODE_ENV=production and a build dir is
// configured (STATIC_DIR, set in the Docker image).
if (process.env.NODE_ENV === "production" && process.env.STATIC_DIR) {
  const staticDir = path.resolve(process.env.STATIC_DIR);
  app.use(express.static(staticDir));
  // SPA history fallback: any non-/api GET returns index.html. Unmatched /api
  // routes fall through to the API's own 404 instead of the SPA shell.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
