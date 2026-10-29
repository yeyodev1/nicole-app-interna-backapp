import { Schema, model, Document } from "mongoose";

export interface IPOSDailyEntryItem {
  productName: string;
  unit: string;
  bajas: number;
  bajasNote?: string;
  ventaCombo?: number; // vendido en combos (lo escribe la isla: Contífico no lo desglosa)
  ventaCasaMia?: number; // lo vendido por Casa Mía con producto de la isla (a mano)
  ventaDelaCrem?: number; // ídem Dela Cream
  stockFinal: number;
  stockObjectiveTomorrow: number;
  pedidoSugerido: number;
  pedidoFinal: number;
  deliveryRounds?: Array<{
    label: string;
    quantity: number;
  }>;
}

export interface IPOSDailyEntry extends Document {
  branch: string;
  date: Date;
  submittedBy: string;
  submittedAt: Date;
  items: IPOSDailyEntryItem[];
  status: "draft" | "submitted";
}

const POSDailyEntryItemSchema = new Schema<IPOSDailyEntryItem>(
  {
    productName: { type: String, required: true },
    unit: { type: String, required: true },
    bajas: { type: Number, default: 0 },
    bajasNote: { type: String },
    ventaCombo: { type: Number, default: 0 },
    ventaCasaMia: { type: Number, default: 0 },
    ventaDelaCrem: { type: Number, default: 0 },
    stockFinal: { type: Number, required: true },
    stockObjectiveTomorrow: { type: Number, required: true },
    pedidoSugerido: { type: Number, required: true },
    pedidoFinal: { type: Number, required: true },
    deliveryRounds: [
      {
        label: { type: String, required: true },
        quantity: { type: Number, required: true },
        _id: false,
      },
    ],
  },
  { _id: false }
);

const POSDailyEntrySchema = new Schema<IPOSDailyEntry>(
  {
    branch: { type: String, required: true },
    date: { type: Date, required: true },
    submittedBy: { type: String, required: true },
    submittedAt: { type: Date, default: Date.now },
    items: [POSDailyEntryItemSchema],
    status: { type: String, enum: ["draft", "submitted"], default: "submitted" },
  },
  { timestamps: true }
);

POSDailyEntrySchema.index({ branch: 1, date: 1 }, { unique: true });

export const POSDailyEntryModel = model<IPOSDailyEntry>(
  "POSDailyEntry",
  POSDailyEntrySchema
);
