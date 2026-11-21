import mongoose, { Schema, Document } from "mongoose";

export interface IBranch extends Document {
  name: string;
  isActive: boolean;
  sortOrder: number;
  /** Empresa dueña de la sucursal: "nicole" = La Finestra, "sucree" = Sucrenda (mismos valores que Order.contificoSource). */
  company: "nicole" | "sucree";
  createdAt: Date;
  updatedAt: Date;
}

const branchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    company: { type: String, enum: ["nicole", "sucree"], default: "nicole" },
  },
  { timestamps: true }
);

export const Branch = mongoose.model<IBranch>("Branch", branchSchema);
