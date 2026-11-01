import express from "express";
import type { Response } from "express";

import http from "http";
import cors from "cors";
import routerApi from "./routes";
import { mountMcpOAuth } from "./routes/mcp-oauth.router";
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

  mountMcpOAuth(app);
  routerApi(app);

  app.use(globalErrorHandler);

  return { app, server };
}
