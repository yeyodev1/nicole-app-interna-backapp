import { createHash, randomBytes } from "crypto";
import CustomError from "../../errors/customError.error";
import { McpOAuthClientModel, McpOAuthCodeModel, McpOAuthTokenModel } from "../../models/mcp-oauth.model";
import { McpUserModel, type IMcpUser } from "../../models/mcp-user.model";

/** Origen público del backend (issuer) y del portal donde la persona inicia sesión. */
export const API_ORIGIN = (process.env.MCP_API_ORIGIN || "https://nicole-order-backapp.vercel.app").replace(/\/+$/, "");
export const PORTAL_ORIGIN = (process.env.MCP_PORTAL_ORIGIN || "https://app.nicole.com.ec").replace(/\/+$/, "");
export const MCP_RESOURCE = `${API_ORIGIN}/api/mcp`;

const ACCESS_TTL_MS = 7 * 24 * 3600 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const rand = (n = 32) => randomBytes(n).toString("base64url");

export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [API_ORIGIN],
    bearer_methods_supported: ["header"],
    resource_name: "Nicole y Sucrée (solo lectura)",
  };
}

export function authorizationServerMetadata() {
  return {
    issuer: API_ORIGIN,
    authorization_endpoint: `${API_ORIGIN}/oauth/authorize`,
    token_endpoint: `${API_ORIGIN}/oauth/token`,
    registration_endpoint: `${API_ORIGIN}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["lectura"],
  };
}

const validRedirect = (u: unknown) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

/** Registro dinámico de clientes (RFC 7591): Claude se registra solo al conectar. */
export async function registerClient(body: any) {
  const redirectUris: string[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length || !redirectUris.every(validRedirect)) {
    throw Object.assign(new CustomError("redirect_uris inválidas", 400), { oauth: "invalid_redirect_uri" });
  }
  const clientId = `mcp_${rand(18)}`;
  await McpOAuthClientModel.create({ clientId, clientName: String(body?.client_name || "").slice(0, 80), redirectUris });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body?.client_name || undefined,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Revisa la solicitud de /oauth/authorize antes de mandar a la persona a iniciar sesión. */
export async function checkAuthorizeRequest(q: Record<string, unknown>) {
  const clientId = String(q.client_id || "");
  const redirectUri = String(q.redirect_uri || "");
  const client: any = await McpOAuthClientModel.findOne({ clientId }).lean();
  if (!client) throw new CustomError("Cliente desconocido. Vuelve a conectar desde Claude.", 400);
  if (!client.redirectUris.includes(redirectUri)) throw new CustomError("redirect_uri no registrada.", 400);
  if (q.response_type !== "code") throw new CustomError("response_type debe ser code.", 400);
  if (!q.code_challenge || (q.code_challenge_method && q.code_challenge_method !== "S256")) {
    throw new CustomError("Falta PKCE (S256).", 400);
  }
  return { clientName: client.clientName || "Claude" };
}

/** La persona ya inició sesión en el portal y aprobó: código de un solo uso → redirect a Claude. */
export async function approve(user: IMcpUser, q: Record<string, unknown>) {
  await checkAuthorizeRequest(q);
  const code = rand(32);
  await McpOAuthCodeModel.create({
    codeHash: sha(code),
    clientId: String(q.client_id),
    redirectUri: String(q.redirect_uri),
    userId: user._id,
    codeChallenge: String(q.code_challenge),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const url = new URL(String(q.redirect_uri));
  url.searchParams.set("code", code);
  if (q.state) url.searchParams.set("state", String(q.state));
  return { redirectTo: url.toString() };
}

const oauthError = (error: string, description: string, status = 400) =>
  Object.assign(new CustomError(description, status), { oauth: error });

async function issueTokens(clientId: string, userId: unknown) {
  const access = rand(32);
  const refresh = rand(32);
  await McpOAuthTokenModel.create({
    accessHash: sha(access),
    refreshHash: sha(refresh),
    clientId,
    userId,
    accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: "lectura" };
}

export async function token(body: any) {
  const grant = String(body?.grant_type || "");
  const clientId = String(body?.client_id || "");
  if (grant === "authorization_code") {
    const code: any = await McpOAuthCodeModel.findOneAndUpdate(
      { codeHash: sha(String(body?.code || "")), used: false },
      { $set: { used: true } }
    );
    if (!code || code.expiresAt.getTime() < Date.now()) throw oauthError("invalid_grant", "Código inválido o vencido.");
    if (code.clientId !== clientId || code.redirectUri !== String(body?.redirect_uri || "")) {
      throw oauthError("invalid_grant", "El código no corresponde a este cliente.");
    }
    const challenge = createHash("sha256").update(String(body?.code_verifier || "")).digest("base64url");
    if (challenge !== code.codeChallenge) throw oauthError("invalid_grant", "PKCE inválido.");
    const user = await McpUserModel.findOne({ _id: code.userId, active: true });
    if (!user) throw oauthError("invalid_grant", "Acceso desactivado.");
    return issueTokens(clientId, code.userId);
  }
  if (grant === "refresh_token") {
    const old: any = await McpOAuthTokenModel.findOneAndUpdate(
      { refreshHash: sha(String(body?.refresh_token || "")), revoked: false },
      { $set: { revoked: true } }
    );
    if (!old || old.refreshExpiresAt.getTime() < Date.now()) throw oauthError("invalid_grant", "Refresh token inválido.");
    const user = await McpUserModel.findOne({ _id: old.userId, active: true });
    if (!user) throw oauthError("invalid_grant", "Acceso desactivado.");
    return issueTokens(old.clientId, old.userId);
  }
  throw oauthError("unsupported_grant_type", "grant_type no soportado.");
}

/** Persona dueña de un access token; null si venció, se revocó o la persona ya no está activa. */
export async function userFromAccessToken(bearer: string | undefined): Promise<IMcpUser | null> {
  const raw = String(bearer || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) return null;
  const t: any = await McpOAuthTokenModel.findOne({ accessHash: sha(raw), revoked: false }).lean();
  if (!t || t.accessExpiresAt.getTime() < Date.now()) return null;
  return McpUserModel.findOne({ _id: t.userId, active: true });
}
