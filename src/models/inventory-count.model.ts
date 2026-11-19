import { Schema, model, models as mongooseModels, Document, Types } from "mongoose";

/**
 * Toma de inventario de una empresa. Cada bloque se cuenta por separado y se puede cerrar; se puede
 * pasar de un bloque a otro sin cerrar el anterior. El mismo día de la toma un bloque cerrado se
 * puede reabrir para corregir; desde la medianoche (hora de Ecuador) la toma queda bloqueada y se
 * empieza una toma nueva.
 */
export interface IInventoryCountItem {
  code: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
}

export interface IInventoryCountUtensilItem {
  utensil: Types.ObjectId;
  name: string;
  quantity: number;
}

export interface IInventoryCountBlock<T> {
  status: "open" | "closed";
  items: T[];
  updatedBy?: string;
  closedAt?: Date | null;
  closedBy?: string | null;
  reopenedAt?: Date | null;
  reopenedBy?: string | null;
}

export interface IInventoryCount extends Document {
  company: "nicole" | "sucree";
  /** Fecha de la toma, AAAA-MM-DD en hora de Ecuador. Hasta el 18/11/2026 era el lunes de la semana. */
  weekOf: string;
  responsible: string;
  pt: IInventoryCountBlock<IInventoryCountItem>;
  pp: IInventoryCountBlock<IInventoryCountItem>;
  mp: IInventoryCountBlock<IInventoryCountItem>;
  ut: IInventoryCountBlock<IInventoryCountUtensilItem>;
  createdAt: Date;
  updatedAt: Date;
}

const ItemSchema = new Schema<IInventoryCountItem>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true },
  },
  { _id: false }
);

const UtensilItemSchema = new Schema<IInventoryCountUtensilItem>(
  {
    utensil: { type: Schema.Types.ObjectId, ref: "InventoryUtensil", required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const blockOf = (itemSchema: Schema) =>
  new Schema(
    {
      status: { type: String, enum: ["open", "closed"], default: "open" },
      items: { type: [itemSchema], default: [] },
      updatedBy: { type: String, default: null },
      closedAt: { type: Date, default: null },
      closedBy: { type: String, default: null },
      reopenedAt: { type: Date, default: null },
      reopenedBy: { type: String, default: null },
    },
    { _id: false }
  );

const InventoryCountSchema = new Schema<IInventoryCount>(
  {
    company: { type: String, enum: ["nicole", "sucree"], required: true },
    weekOf: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    responsible: { type: String, default: "" },
    pt: { type: blockOf(ItemSchema), default: () => ({}) },
    pp: { type: blockOf(ItemSchema), default: () => ({}) },
    mp: { type: blockOf(ItemSchema), default: () => ({}) },
    ut: { type: blockOf(UtensilItemSchema), default: () => ({}) },
  },
  { timestamps: true }
);

InventoryCountSchema.index({ company: 1, weekOf: 1 }, { unique: true });

export const InventoryCountModel =
  mongooseModels.InventoryCount || model<IInventoryCount>("InventoryCount", InventoryCountSchema);
