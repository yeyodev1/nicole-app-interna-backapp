import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Orden 2: comentario que justifica una anomalía (Diferencia ≠ 0) del Detalle del Día,
 * enlazado a sucursal + día + producto. Orden 8: productKey = código de Contífico si lo tiene.
 */
export interface IPosAnomalyNote extends Document {
  branch: string; // nombre como se muestra
  branchKey: string; // normalizeString(branch)
  date: string; // AAAA-MM-DD
  productName: string;
  productKey: string; // código de Contífico o normalizeString(productName)
  codigo?: string | null;
  descuadre: number; // diferencia al momento de comentar
  comment: string;
  createdBy: string;
  updatedBy: string;
}

const PosAnomalyNoteSchema = new Schema<IPosAnomalyNote>(
  {
    branch: { type: String, required: true, trim: true },
    branchKey: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    productName: { type: String, required: true, trim: true },
    productKey: { type: String, required: true },
    codigo: { type: String, default: null },
    descuadre: { type: Number, default: 0 },
    comment: { type: String, required: true, trim: true, maxlength: 500 },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
  },
  { timestamps: true }
);

PosAnomalyNoteSchema.index({ branchKey: 1, date: 1, productKey: 1 }, { unique: true });

export const PosAnomalyNoteModel =
  mongooseModels.PosAnomalyNote || model<IPosAnomalyNote>("PosAnomalyNote", PosAnomalyNoteSchema);
