import express from "express";
import * as McpController from "../controllers/mcp.controller";

/**
 * Conector MCP de solo lectura para Claude (Nicole + Sucrée).
 * - /api/mcp-portal/*: portal en app.nicole.com.ec/mcp (correo + contraseña + código por correo).
 * - /api/mcp/:token: el servidor MCP; el token es el link secreto de cada persona.
 */
export const McpPortalRouter = express.Router();
McpPortalRouter.post("/login", McpController.login);
McpPortalRouter.post("/verify", McpController.verify);
McpPortalRouter.get("/me", McpController.me);
McpPortalRouter.post("/me/connector", McpController.regenerateMine);
McpPortalRouter.get("/users", McpController.listUsers);
McpPortalRouter.post("/users", McpController.createUser);
McpPortalRouter.patch("/users/:id", McpController.updateUser);
McpPortalRouter.delete("/users/:id", McpController.deleteUser);
McpPortalRouter.get("/oauth/check", McpController.oauthCheck);
McpPortalRouter.post("/oauth/approve", McpController.oauthApprove);

export const McpRouter = express.Router();
// OAuth: URL única para todos; Claude manda al portal a iniciar sesión.
McpRouter.post("/", McpController.mcpEndpoint);
McpRouter.get("/", McpController.mcpMethodNotAllowed);
McpRouter.delete("/", McpController.mcpMethodNotAllowed);
McpRouter.post("/:token", McpController.mcpEndpoint);
McpRouter.get("/:token", McpController.mcpMethodNotAllowed);
McpRouter.delete("/:token", McpController.mcpMethodNotAllowed);
