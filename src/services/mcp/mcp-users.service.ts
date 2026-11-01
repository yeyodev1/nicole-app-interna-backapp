import bcrypt from "bcryptjs";
import CustomError from "../../errors/customError.error";
import { McpUserModel, type IMcpUser } from "../../models/mcp-user.model";
import { newConnectorToken, publicUser } from "./mcp-auth.service";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertManager(actor: IMcpUser) {
  if (!actor.canManage) throw new CustomError("No tienes permiso para administrar personas.", 403);
}

export async function listUsers(actor: IMcpUser) {
  assertManager(actor);
  const users: IMcpUser[] = await McpUserModel.find().sort({ createdAt: 1 });
  return users.map((u) => publicUser(u));
}

export async function createUser(actor: IMcpUser, body: any) {
  assertManager(actor);
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!EMAIL.test(email)) throw new CustomError("Escribe un correo válido.", 400);
  if (password.length < 8) throw new CustomError("La contraseña debe tener al menos 8 caracteres.", 400);
  if (await McpUserModel.exists({ email })) throw new CustomError("Ese correo ya tiene acceso.", 409);
  const user = await McpUserModel.create({
    email,
    name: String(body?.name ?? "").trim().slice(0, 60),
    passwordHash: await bcrypt.hash(password, 10),
    active: true,
    canManage: body?.canManage === true,
    connectorToken: newConnectorToken(),
    createdBy: actor.email,
  });
  return publicUser(user);
}

export async function updateUser(actor: IMcpUser, id: string, body: any) {
  assertManager(actor);
  const user: IMcpUser | null = await McpUserModel.findById(id).catch(() => null);
  if (!user) throw new CustomError("Persona no encontrada.", 404);
  const self = String(user._id) === String(actor._id);
  if (typeof body?.active === "boolean") {
    if (self && !body.active) throw new CustomError("No puedes desactivarte a ti mismo.", 400);
    user.active = body.active;
  }
  if (typeof body?.canManage === "boolean") {
    if (self && !body.canManage) throw new CustomError("No puedes quitarte tu propio permiso de administrar.", 400);
    user.canManage = body.canManage;
  }
  if (typeof body?.name === "string") user.name = body.name.trim().slice(0, 60);
  if (typeof body?.password === "string" && body.password) {
    if (body.password.length < 8) throw new CustomError("La contraseña debe tener al menos 8 caracteres.", 400);
    user.passwordHash = await bcrypt.hash(body.password, 10);
  }
  // Link nuevo: el anterior deja de funcionar (si se filtró, se regenera).
  if (body?.regenerateConnector === true) user.connectorToken = newConnectorToken();
  await user.save();
  return publicUser(user);
}

export async function deleteUser(actor: IMcpUser, id: string) {
  assertManager(actor);
  if (String(actor._id) === id) throw new CustomError("No puedes quitarte a ti mismo.", 400);
  const res = await McpUserModel.deleteOne({ _id: id }).catch(() => null);
  if (!res?.deletedCount) throw new CustomError("Persona no encontrada.", 404);
  return { deleted: true };
}

/** Regenera el link propio (si se compartió por error). */
export async function regenerateOwnConnector(actor: IMcpUser) {
  actor.connectorToken = newConnectorToken();
  await actor.save();
  return publicUser(actor, true);
}
