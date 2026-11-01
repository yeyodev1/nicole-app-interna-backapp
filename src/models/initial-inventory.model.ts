import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Inventario inicial de una sucursal para un día: con cuánto EMPEZÓ cada producto.
 * Lo registra Operaciones cuando no hay cierre del día anterior (sucursal nueva, un día
 * sin cierre) o para corregir el punto de partida. En Sobrantes/Descuadres manda sobre el
 * cierre anterior.
 */
export interface IInitialInventoryItem {
  productName: string;
  unit: string;
  quantity: number;
}

export interface IInitialInventory extends Document {
  branch: string;
  date: Date;
  items: IInitialInventoryItem[];
  note?: string;
  createdBy: string;
  updatedBy?: string;
}

const ItemSchema = new Schema<IInitialInventoryItem>(
  {
    productName: { type: String, required: true, trim: true },
    unit: { type: String, default: "unidad", trim: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const InitialInventorySchema = new Schema<IInitialInventory>(
  {
    branch: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    items: { type: [ItemSchema], default: [] },
    note: { type: String, trim: true },
    createdBy: { type: String, required: true },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

InitialInventorySchema.index({ branch: 1, date: 1 }, { unique: true });

export const InitialInventoryModel =
  mongooseModels.InitialInventory || model<IInitialInventory>("InitialInventory", InitialInventorySchema);
