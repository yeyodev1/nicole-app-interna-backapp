import { Schema, model, models as mongooseModels, Document, Types } from "mongoose";

/**
 * Ingreso de producción: lo que un operario registra en la tablet de planta.
 * La foto NO se guarda aquí: solo queda la última del operario (ProductionOperator.photo).
 */
export interface IProductionEntryItem {
  code: string; // código de Contífico
  name: string;
  category: string;
  quantity: number;
}

export interface IProductionEntry extends Document {
  date: string; // AAAA-MM-DD, hora de Ecuador
  operator: Types.ObjectId;
  operatorName: string;
  company: "nicole" | "sucree";
  area: string;
  items: IProductionEntryItem[];
  totalUnits: number;
  createdBy: string; // usuario de la app con el que se registró (la tablet)
  createdAt: Date;
  updatedAt: Date;
}

const ItemSchema = new Schema<IProductionEntryItem>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const ProductionEntrySchema = new Schema<IProductionEntry>(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    operator: { type: Schema.Types.ObjectId, ref: "ProductionOperator", required: true },
    operatorName: { type: String, required: true },
    company: { type: String, enum: ["nicole", "sucree"], required: true },
    area: { type: String, required: true },
    items: { type: [ItemSchema], required: true },
    totalUnits: { type: Number, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true }
);

ProductionEntrySchema.index({ date: 1 });
ProductionEntrySchema.index({ operator: 1, date: 1 });

export const ProductionEntryModel =
  mongooseModels.ProductionEntry || model<IProductionEntry>("ProductionEntry", ProductionEntrySchema);
