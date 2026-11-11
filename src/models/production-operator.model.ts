import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Operario de la planta que registra su producción en la tablet.
 * La lista la maneja el Jefe de Operaciones. Borrar = desactivar: el historial se conserva.
 * Solo se guarda una foto por operario (la última selfie), comprimida.
 */
export interface IProductionOperator extends Document {
  name: string;
  nameKey: string; // nombre en minúsculas, sin espacios extra: evita "Frank" y "frank" duplicados
  active: boolean;
  photo: string | null; // data URL JPEG comprimida
  photoAt: Date | null;
  createdBy: string;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProductionOperatorSchema = new Schema<IProductionOperator>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    nameKey: { type: String, required: true },
    active: { type: Boolean, default: true },
    photo: { type: String, default: null },
    photoAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

ProductionOperatorSchema.index({ nameKey: 1 }, { unique: true });

export const ProductionOperatorModel =
  mongooseModels.ProductionOperator ||
  model<IProductionOperator>("ProductionOperator", ProductionOperatorSchema);
