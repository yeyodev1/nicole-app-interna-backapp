import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Personas habilitadas para el conector MCP de solo lectura (Nicole + Sucrée).
 * Entran al portal /mcp con correo + contraseña + código por correo. Cada una tiene su
 * propio link secreto del conector (`connectorToken`): al desactivarla o borrarla, ese
 * link deja de responder al instante aunque ya esté conectado en Claude.
 */
export interface IMcpUser extends Document {
  email: string;
  name?: string;
  passwordHash: string;
  active: boolean;
  /** Puede agregar y quitar personas en el portal. */
  canManage: boolean;
  connectorToken: string;
  loginCode?: { hash: string; expiresAt: Date; attempts: number };
  lastLoginAt?: Date;
  lastMcpAt?: Date;
  createdBy?: string;
}

const McpUserSchema = new Schema<IMcpUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true },
    passwordHash: { type: String, required: true },
    active: { type: Boolean, default: true },
    canManage: { type: Boolean, default: false },
    connectorToken: { type: String, required: true, unique: true },
    loginCode: {
      hash: { type: String },
      expiresAt: { type: Date },
      attempts: { type: Number, default: 0 },
    },
    lastLoginAt: { type: Date },
    lastMcpAt: { type: Date },
    createdBy: { type: String },
  },
  { timestamps: true }
);

export const McpUserModel = mongooseModels.McpUser || model<IMcpUser>("McpUser", McpUserSchema);
