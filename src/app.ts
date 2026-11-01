import express from "express";
import type { Response } from "express";

import http from "http";
import cors from "cors";
import routerApi from "./routes";
import { mountMcpOAuth } from "./routes/mcp-oauth.router";
import mongoose from "mongoose";
import { ensureDb } from "./config/mongo";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

export default function createApp() {
  const app = express();

  const server = http.createServer(app);

  const whitelist = [
    "http://localhost:8100",
    "http://localhost:8101",
    "http://localhost:8080",
    "http://localhost:5173",
    "https://nicole-sells-bills.netlify.app",
    "https://testing-storybrand-frontend.bakano.ec"
  ];

  const corsOptions = {
    origin: true, // Allow all origins (reflects request origin)
    credentials: true,
  };

  app.use(cors(corsOptions));

  app.use((req, res, next) => {
    next();
  });

  app.use(express.json({ limit: "50mb" }));

  app.get("/", (_req, res: Response) => {
    res.send("factura y ordenes de nicole backend IS ALIVEEEEEEE debbbugeando:)");
  });

  // Antes de cualquier ruta: asegura la conexión a Mongo (la rehace si se cayó).
  app.use(async (_req, res, next) => {
    try {
      await ensureDb();
      next();
    } catch (error) {
      console.error("❌ Sin conexión a la base de datos:", error);
      res.status(503).json({ message: "La base de datos no responde. Intenta de nuevo en unos segundos." });
    }
  });

  // Salud del sistema (para monitoreo): 200 solo si Mongo responde.
  app.get("/api/health", async (_req, res: Response) => {
    try {
      await mongoose.connection.db!.admin().ping();
      res.status(200).json({ ok: true, db: "ok", at: new Date().toISOString() });
    } catch (error) {
      res.status(503).json({ ok: false, db: "error" });
    }
  });

  mountMcpOAuth(app);
  routerApi(app);

  app.use(globalErrorHandler);

  return { app, server };
}
