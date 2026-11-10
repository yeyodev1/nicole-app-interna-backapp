import { Schema, model, Document } from "mongoose";

export type WeeklyObjectives = {
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
};

export interface IPOSStockObjective extends Document {
  branch: "San Marino" | "Mall del Sol" | "Centro de Producción";
  productName: string;
  unit: string;
  contificoId?: string;
  isGeneral: boolean;
  requiresMinimum: boolean;
  category: "Producción" | "Bodega";
  objectives: WeeklyObjectives;
}

const POSStockObjectiveSchema = new Schema<IPOSStockObjective>(
  {
    branch: {
      type: String,
      enum: ["San Marino", "Mall del Sol", "Centro de Producción"],
      required: true,
    },
    productName: { type: String, required: true },
    unit: { type: String, required: true, default: "unidad" },
    contificoId: { type: String },
    isGeneral: { type: Boolean, default: false },
    requiresMinimum: { type: Boolean, default: false },
    category: {
      type: String,
      enum: ["Producción", "Bodega"],
      default: "Producción",
    },
    objectives: {
      monday: { type: Number, default: 0 },
      tuesday: { type: Number, default: 0 },
      wednesday: { type: Number, default: 0 },
      thursday: { type: Number, default: 0 },
      friday: { type: Number, default: 0 },
      saturday: { type: Number, default: 0 },
      sunday: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

POSStockObjectiveSchema.index({ branch: 1, productName: 1 }, { unique: true });
// Orden 8: un solo producto por código de Contífico en cada isla
POSStockObjectiveSchema.index(
  { branch: 1, contificoId: 1 },
  { unique: true, partialFilterExpression: { contificoId: { $type: "string" } } }
);

export const POSStockObjectiveModel = model<IPOSStockObjective>(
  "POSStockObjective",
  POSStockObjectiveSchema
);
