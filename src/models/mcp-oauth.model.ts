import { Schema, model, models as mongooseModels } from "mongoose";

/**
 * OAuth 2.1 del conector MCP (lo usa Claude al "Conectar"): clientes registrados por DCR,
 * códigos de autorización (PKCE S256, 5 min, un solo uso) y tokens (guardados como hash).
 */
const ClientSchema = new Schema(
  {
    clientId: { type: String, required: true, unique: true },
    clientName: { type: String },
    redirectUris: { type: [String], default: [] },
  },
  { timestamps: true }
);

const CodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "McpUser", required: true },
    codeChallenge: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const TokenSchema = new Schema(
  {
    accessHash: { type: String, required: true, unique: true },
    refreshHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "McpUser", required: true },
    accessExpiresAt: { type: Date, required: true },
    refreshExpiresAt: { type: Date, required: true },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const McpOAuthClientModel = mongooseModels.McpOAuthClient || model("McpOAuthClient", ClientSchema);
export const McpOAuthCodeModel = mongooseModels.McpOAuthCode || model("McpOAuthCode", CodeSchema);
export const McpOAuthTokenModel = mongooseModels.McpOAuthToken || model("McpOAuthToken", TokenSchema);
