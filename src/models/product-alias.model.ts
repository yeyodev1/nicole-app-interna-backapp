import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Orden 8: nombre usado en la app (cierres, pedidos, catálogo de islas) → producto de Contífico.
 * `alias` va normalizado (normalizeString). Lo edita Operaciones.
 */
export interface IProductAlias extends Document {
  alias: string;
  aliasName: string; // tal como se escribió
  codigo: string; // código de Contífico (ej. IND-024)
  contificoId?: string;
  createdBy?: string;
  updatedBy?: string;
}

const ProductAliasSchema = new Schema<IProductAlias>(
  {
    alias: { type: String, required: true, trim: true },
    aliasName: { type: String, required: true, trim: true },
    codigo: { type: String, required: true, trim: true },
    contificoId: { type: String, trim: true },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

ProductAliasSchema.index({ alias: 1 }, { unique: true });

export const ProductAliasModel =
  mongooseModels.ProductAlias || model<IProductAlias>("ProductAlias", ProductAliasSchema);
