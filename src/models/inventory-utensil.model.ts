import { Schema, model, models as mongooseModels, Document } from "mongoose";

/** Utensilio del inventario semanal. Todo utensilio se registra con su foto. */
export interface IInventoryUtensil extends Document {
  company: "nicole" | "sucree";
  name: string;
  nameKey: string; // nombre en minúsculas y sin espacios dobles, para no repetirlo
  photo: string; // data URL JPEG comprimida
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const InventoryUtensilSchema = new Schema<IInventoryUtensil>(
  {
    company: { type: String, enum: ["nicole", "sucree"], required: true },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    photo: { type: String, required: true },
    active: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true }
);

InventoryUtensilSchema.index({ company: 1, nameKey: 1 }, { unique: true });

export const InventoryUtensilModel =
  mongooseModels.InventoryUtensil || model<IInventoryUtensil>("InventoryUtensil", InventoryUtensilSchema);
