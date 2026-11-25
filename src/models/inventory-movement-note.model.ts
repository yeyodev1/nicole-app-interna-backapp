import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Comentario de un producto en el Movimiento de inventario, guardado por empresa + periodo
 * (la toma que abre la semana, AAAA-MM-DD) + producto (código del catálogo). Pedido de Operaciones
 * (Mauro/Ricardo, 25/11/2026): se puede comentar cualquier producto, haya o no diferencia.
 */
export interface IInventoryMovementNote extends Document {
  company: "nicole" | "sucree";
  from: string; // AAAA-MM-DD: toma que abre el periodo
  code: string;
  codeKey: string; // código normalizado
  name: string;
  comment: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const InventoryMovementNoteSchema = new Schema<IInventoryMovementNote>(
  {
    company: { type: String, enum: ["nicole", "sucree"], required: true },
    from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    code: { type: String, required: true, trim: true },
    codeKey: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    comment: { type: String, required: true, trim: true, maxlength: 500 },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
  },
  { timestamps: true }
);

InventoryMovementNoteSchema.index({ company: 1, from: 1, codeKey: 1 }, { unique: true });

export const InventoryMovementNoteModel =
  mongooseModels.InventoryMovementNote ||
  model<IInventoryMovementNote>("InventoryMovementNote", InventoryMovementNoteSchema);
