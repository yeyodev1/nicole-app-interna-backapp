/**
 * Crea las cuentas por defecto del portal MCP (Mauro y Diego) si no existen.
 * La contraseña inicial se pasa por entorno y nunca se guarda en el repo (es público):
 *
 *   MCP_SEED_PASSWORD='...' pnpm seed:mcp-users
 */
import "dotenv/config";
import mongoose from "mongoose";
import { seedMcpUsers } from "../src/services/mcp/mcp-auth.service";
import { McpUserModel } from "../src/models/mcp-user.model";

async function main() {
  const uri = process.env.DB_URI;
  if (!uri) throw new Error("Falta DB_URI");
  await mongoose.connect(uri);
  await seedMcpUsers(process.env.MCP_SEED_PASSWORD || "");
  const users = await McpUserModel.find().select("email active canManage").lean();
  console.log("Accesos MCP:", users.map((u: any) => `${u.email} (${u.active ? "activo" : "inactivo"}${u.canManage ? ", administra" : ""})`).join(" · "));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
