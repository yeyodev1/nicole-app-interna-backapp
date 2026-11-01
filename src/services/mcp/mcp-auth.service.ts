import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import CustomError from "../../errors/customError.error";
import { McpUserModel, type IMcpUser } from "../../models/mcp-user.model";
import { EmailService } from "../email.service";
import { JWT_SECRET } from "../../utils/jwt.handle";

/**
 * Acceso al portal del conector MCP (/mcp de la app interna). Paso 1: correo + contraseña →
 * se manda un código de 6 dígitos al correo (vence en 10 min, 5 intentos). Paso 2: código →
 * sesión de 12 h (JWT con `kind: "mcp-portal"`, distinto del de la app interna).
 */
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_HOURS = 12;

/** Las dos personas con acceso por defecto (decisión de Diego, 31/10/2026). */
const DEFAULT_USERS = [
  { email: "mauro.salgan@gmail.com", name: "Mauro" },
  { email: "dreyes@bakano.ec", name: "Diego" },
];

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const newConnectorToken = () => randomBytes(24).toString("hex");

/**
 * Crea las cuentas por defecto si no existen (no pisa contraseñas ni permisos ya cambiados).
 * La contraseña inicial NUNCA va en el código (repo público): llega por parámetro desde
 * `scripts/seed-mcp-users.ts` con la variable de entorno MCP_SEED_PASSWORD.
 */
export async function seedMcpUsers(initialPassword: string) {
  if (!initialPassword || initialPassword.length < 8) throw new Error("MCP_SEED_PASSWORD debe tener al menos 8 caracteres");
  for (const u of DEFAULT_USERS) {
    const exists = await McpUserModel.exists({ email: u.email });
    if (exists) continue;
    await McpUserModel.create({
      email: u.email,
      name: u.name,
      passwordHash: await bcrypt.hash(initialPassword, 10),
      active: true,
      canManage: true,
      connectorToken: newConnectorToken(),
      createdBy: "sistema",
    });
  }
}

export async function startLogin(emailRaw: unknown, passwordRaw: unknown) {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const password = String(passwordRaw ?? "");
  const user: IMcpUser | null = await McpUserModel.findOne({ email });
  const ok = !!user && user.active && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw new CustomError("Correo o contraseña incorrectos, o el acceso está desactivado.", 401);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  user!.loginCode = { hash: sha(code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 };
  await user!.save();

  const sent = await new EmailService().sendBranded({
    to: email,
    subject: `Tu código de acceso: ${code}`,
    bodyHtml: `<p>Hola${user!.name ? ` ${user!.name}` : ""},</p>
      <p>Tu código para entrar al conector de Claude de Nicole y Sucrée es:</p>
      <p style="font-size:30px;font-weight:bold;letter-spacing:6px;text-align:center;color:#490f57;">${code}</p>
      <p style="color:#6b7280;font-size:13px;">Vence en 10 minutos. Si no fuiste tú, ignora este correo.</p>`,
  });
  if (!sent) throw new CustomError("No pudimos enviar el código por correo. Intenta de nuevo en un minuto.", 502);
  return { sent: true, email };
}

export async function verifyLogin(emailRaw: unknown, codeRaw: unknown) {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const code = String(codeRaw ?? "").replace(/\D/g, "");
  const user: IMcpUser | null = await McpUserModel.findOne({ email });
  const lc = user?.loginCode;
  if (!user || !user.active || !lc?.hash || !lc.expiresAt || lc.expiresAt.getTime() < Date.now()) {
    throw new CustomError("El código venció. Vuelve a ingresar tu contraseña para recibir otro.", 401);
  }
  if ((lc.attempts || 0) >= MAX_ATTEMPTS) {
    throw new CustomError("Demasiados intentos. Vuelve a ingresar tu contraseña para recibir otro código.", 429);
  }
  const good = code.length === 6 && timingSafeEqual(Buffer.from(sha(code)), Buffer.from(lc.hash));
  if (!good) {
    user.loginCode = { ...lc, attempts: (lc.attempts || 0) + 1 } as any;
    await user.save();
    throw new CustomError("Código incorrecto.", 401);
  }
  user.loginCode = undefined;
  user.lastLoginAt = new Date();
  await user.save();
  const token = jwt.sign({ kind: "mcp-portal", uid: String(user._id) }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
  return { token, user: publicUser(user, true) };
}

/** Usuario de la sesión del portal; 401 si se desactivó o borró después de entrar. */
export async function portalUserFromToken(bearer: string | undefined): Promise<IMcpUser> {
  const raw = String(bearer || "").replace(/^Bearer\s+/i, "");
  let payload: any;
  try {
    payload = jwt.verify(raw, JWT_SECRET);
  } catch {
    throw new CustomError("Tu sesión venció. Vuelve a entrar.", 401);
  }
  if (payload?.kind !== "mcp-portal") throw new CustomError("Sesión inválida.", 401);
  const user: IMcpUser | null = await McpUserModel.findById(payload.uid);
  if (!user || !user.active) throw new CustomError("Tu acceso fue desactivado.", 401);
  return user;
}

export function publicUser(u: IMcpUser, withConnector = false) {
  return {
    _id: String(u._id),
    email: u.email,
    name: u.name || "",
    active: u.active,
    canManage: u.canManage,
    lastLoginAt: u.lastLoginAt || null,
    lastMcpAt: u.lastMcpAt || null,
    createdBy: u.createdBy || "",
    ...(withConnector ? { connectorToken: u.connectorToken } : {}),
  };
}
