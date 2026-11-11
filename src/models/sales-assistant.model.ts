import { Schema, model, Document } from "mongoose";

/**
 * Asistente de ventas: cada vez que un comercial pulsa "Analizar ahora" se guarda un
 * análisis con las conversaciones del CRM clasificadas por Claude (calientes, tibios,
 * tareas) más los pedidos de la app que esperan algo del cliente.
 */
export type SalesAssistantGroup = "CALIENTE" | "TIBIO" | "TAREA";
export type SalesAssistantSource = "crm" | "app";

export interface ISalesAssistantItem {
  /** Clave estable para las casillas: `crm:<conversación>:<fecha último mensaje>` o `order:<id>`. */
  key: string;
  group: SalesAssistantGroup;
  source: SalesAssistantSource;
  marca: "nicole" | "sucree";
  cliente: string;
  telefono?: string;
  ultimoMensaje?: string;
  ultimoMensajeDe?: "cliente" | "equipo";
  recibido?: string;
  motivo: string;
  puntaje?: number;
  tarea?: string;
  detalle?: string;
  mensaje: string;
  conversationId?: string;
  orderId?: string;
}

export interface ISalesAssistantAnalysis extends Document {
  status: "RUNNING" | "DONE" | "ERROR";
  from: Date;
  to: Date;
  by: { id?: string; name: string };
  items: ISalesAssistantItem[];
  conversationsRead: number;
  warnings: string[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ItemSchema = new Schema<ISalesAssistantItem>(
  {
    key: { type: String, required: true },
    group: { type: String, enum: ["CALIENTE", "TIBIO", "TAREA"], required: true },
    source: { type: String, enum: ["crm", "app"], required: true },
    marca: { type: String, enum: ["nicole", "sucree"], required: true },
    cliente: { type: String, required: true },
    telefono: String,
    ultimoMensaje: String,
    ultimoMensajeDe: { type: String, enum: ["cliente", "equipo"] },
    recibido: String,
    motivo: { type: String, default: "" },
    puntaje: Number,
    tarea: String,
    detalle: String,
    mensaje: { type: String, default: "" },
    conversationId: String,
    orderId: String,
  },
  { _id: false }
);

const AnalysisSchema = new Schema<ISalesAssistantAnalysis>(
  {
    status: { type: String, enum: ["RUNNING", "DONE", "ERROR"], default: "RUNNING" },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    by: { id: String, name: { type: String, required: true } },
    items: { type: [ItemSchema], default: [] },
    conversationsRead: { type: Number, default: 0 },
    warnings: { type: [String], default: [] },
    error: String,
  },
  { timestamps: true, versionKey: false }
);

AnalysisSchema.index({ createdAt: -1 });
// Se borran solos a los 30 días.
AnalysisSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

/**
 * Casillas de los comerciales (Leído / Gestionado / No se gestiona a propósito).
 * Van aparte del análisis para que se mantengan entre un análisis y otro.
 */
export interface ISalesAssistantMark extends Document {
  key: string;
  read: boolean;
  status: "GESTIONADO" | "NO_GESTIONAR" | null;
  by: { id?: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

const MarkSchema = new Schema<ISalesAssistantMark>(
  {
    key: { type: String, required: true, unique: true },
    read: { type: Boolean, default: false },
    status: { type: String, enum: ["GESTIONADO", "NO_GESTIONAR", null], default: null },
    by: { id: String, name: { type: String, required: true } },
  },
  { timestamps: true, versionKey: false }
);

MarkSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const SalesAssistantAnalysisModel = model<ISalesAssistantAnalysis>("SalesAssistantAnalysis", AnalysisSchema);
export const SalesAssistantMarkModel = model<ISalesAssistantMark>("SalesAssistantMark", MarkSchema);
