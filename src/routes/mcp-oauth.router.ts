import express, { Application, Request, Response } from "express";
import CustomError from "../errors/customError.error";
import * as oauth from "../services/mcp/mcp-oauth.service";

/**
 * OAuth del conector MCP en la raíz del dominio (Claude busca /.well-known/... y /oauth/...).
 * /oauth/authorize manda a la persona al portal (app.nicole.com.ec/mcp/autorizar), donde
 * inicia sesión con correo + contraseña + código y aprueba.
 */
const fail = (res: Response, e: unknown) => {
  const err = e as CustomError & { oauth?: string };
  const status = err instanceof CustomError ? err.status : 500;
  if (status >= 500) console.error("❌ MCP OAuth:", e);
  res.status(status).json({ error: err.oauth || (status >= 500 ? "server_error" : "invalid_request"), error_description: err.message });
};

export function mountMcpOAuth(app: Application) {
  const prm = (_req: Request, res: Response) => {
    res.json(oauth.protectedResourceMetadata());
  };
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/*path", prm);
  const asm = (_req: Request, res: Response) => {
    res.json(oauth.authorizationServerMetadata());
  };
  app.get("/.well-known/oauth-authorization-server", asm);
  app.get("/.well-known/oauth-authorization-server/*path", asm);
  app.get("/.well-known/openid-configuration", asm);

  app.post("/oauth/register", async (req, res) => {
    try {
      res.status(201).json(await oauth.registerClient(req.body));
    } catch (e) {
      fail(res, e);
    }
  });

  // Se valida y se manda al portal con los mismos parámetros.
  app.get("/oauth/authorize", async (req, res) => {
    try {
      await oauth.checkAuthorizeRequest(req.query as Record<string, unknown>);
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      res.redirect(302, `${oauth.PORTAL_ORIGIN}/mcp/autorizar?${qs}`);
    } catch (e) {
      res.status(400).send(`<p style="font-family:sans-serif">${(e as Error).message}</p>`);
    }
  });

  app.post("/oauth/token", express.urlencoded({ extended: false }), async (req, res) => {
    try {
      res.set("Cache-Control", "no-store").json(await oauth.token(req.body));
    } catch (e) {
      fail(res, e);
    }
  });
}
