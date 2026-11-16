import { Schema, model, models as mongooseModels, Document } from "mongoose";

/**
 * Catálogo del inventario semanal de una empresa: bloques (producto terminado, en proceso,
 * materia prima) → categorías → productos, más las unidades de medida. Lo edita el Jefe de
 * Operaciones desde Ajustes, con los nombres que quiera. Es independiente de Contífico.
 */
export interface IInventoryCatalogProduct {
  code: string;
  name: string;
  unit: string;
}

export interface IInventoryCatalogCategory {
  name: string;
  products: IInventoryCatalogProduct[];
}

export interface IInventoryCatalogBlock {
  key: "pt" | "pp" | "mp";
  title: string;
  categories: IInventoryCatalogCategory[];
}

export interface IInventoryCatalog extends Document {
  company: "nicole" | "sucree";
  blocks: IInventoryCatalogBlock[];
  units: string[];
  updatedBy: string;
}

const ProductSchema = new Schema<IInventoryCatalogProduct>(
  {
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const CategorySchema = new Schema<IInventoryCatalogCategory>(
  {
    name: { type: String, required: true, trim: true },
    products: { type: [ProductSchema], default: [] },
  },
  { _id: false }
);

const BlockSchema = new Schema<IInventoryCatalogBlock>(
  {
    key: { type: String, enum: ["pt", "pp", "mp"], required: true },
    title: { type: String, required: true, trim: true },
    categories: { type: [CategorySchema], default: [] },
  },
  { _id: false }
);

const InventoryCatalogSchema = new Schema<IInventoryCatalog>(
  {
    company: { type: String, enum: ["nicole", "sucree"], required: true, unique: true },
    blocks: { type: [BlockSchema], default: [] },
    units: { type: [String], default: [] },
    updatedBy: { type: String, default: "sistema" },
  },
  { timestamps: true }
);

export const InventoryCatalogModel =
  mongooseModels.InventoryCatalog || model<IInventoryCatalog>("InventoryCatalog", InventoryCatalogSchema);
