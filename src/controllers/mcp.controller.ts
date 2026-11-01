import { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import CustomError from "../errors/customError.error";
import { McpUserModel } from "../models/mcp-user.model";
import * as auth from "../services/mcp/mcp-auth.service";
import * as users from "../services/mcp/mcp-users.service";
import { buildMcpServer } from "../services/mcp/mcp-tools";

const send = (res: Response, error: unknown) => {
  if (error instanceof CustomError) {
    res.status(error.status).send({ message: error.message });
    return;
  }
  console.error("❌ MCP portal:", error);
  res.status(500).send({ message: "Error interno." });
};

/** Envuelve un handler del portal que necesita sesión. */
const withUser =
  (fn: (user: any, req: Request) => Promise<unknown>) => async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = await auth.portalUserFromToken(req.headers.authorization);
      res.status(200).send(await fn(user, req));
    } catch (error) {
      send(res, error);
    }
  };

export async function login(req: Request, res: Response) {
  try {
    res.status(200).send(await auth.startLogin(req.body?.email, req.body?.password));
  } catch (error) {
    send(res, error);
  }
}

export async function verify(req: Request, res: Response) {
  try {
    res.status(200).send(await auth.verifyLogin(req.body?.email, req.body?.code));
  } catch (error) {
    send(res, error);
  }
}

export const me = withUser(async (user) => auth.publicUser(user, true));
export const regenerateMine = withUser(async (user) => users.regenerateOwnConnector(user));
export const listUsers = withUser(async (user) => users.listUsers(user));
export const createUser = withUser(async (user, req) => users.createUser(user, req.body));
export const updateUser = withUser(async (user, req) => users.updateUser(user, String(req.params.id), req.body));
export const deleteUser = withUser(async (user, req) => users.deleteUser(user, String(req.params.id)));

/**
 * POST /api/mcp/:token — servidor MCP (Streamable HTTP, sin sesión, respuestas JSON).
 * El token del link es de una persona: si se desactiva o se borra, deja de responder aunque
 * Claude ya lo tenga conectado.
 */
export async function mcpEndpoint(req: Request, res: Response) {
  try {
    const token = String(req.params.token || "");
    const user: any = /^[a-f0-9]{48}$/.test(token) ? await McpUserModel.findOne({ connectorToken: token, active: true }) : null;
    if (!user) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Link inválido o acceso desactivado." }, id: null });
      return;
    }
    McpUserModel.updateOne({ _id: user._id }, { $set: { lastMcpAt: new Date() } }).catch(() => undefined);

    const server = buildMcpServer(user.email);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (error) {
    console.error("❌ MCP:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno." }, id: null });
    }
  }
}

/** GET/DELETE /api/mcp/:token — sin sesiones ni SSE en este servidor. */
export function mcpMethodNotAllowed(_req: Request, res: Response) {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Usa POST." }, id: null });
}
