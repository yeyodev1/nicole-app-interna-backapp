import { Schema, model, Document, Types } from "mongoose";

/**
 * Aviso dentro de la app interna (campana del menú). Hoy lo usan los links de
 * gestión de entrega: el cliente completó su link, no lo ha llenado, o el
 * pedido necesita datos de factura.
 */
export type NotificationType =
  | "CLIENT_LINK_COMPLETED"
  | "CLIENT_LINK_PENDING"
  | "CLIENT_LINK_INVOICE_NEEDED"
  | "CLIENT_LINK_INVOICE_ERROR"
  | "WEB_ORDER_NEW";

export interface INotification extends Document {
  user: Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  orderId?: Types.ObjectId;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["CLIENT_LINK_COMPLETED", "CLIENT_LINK_PENDING", "CLIENT_LINK_INVOICE_NEEDED", "CLIENT_LINK_INVOICE_ERROR", "WEB_ORDER_NEW"],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

NotificationSchema.index({ user: 1, createdAt: -1 });
// Se borran solas a los 60 días.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

export const NotificationModel = model<INotification>("Notification", NotificationSchema);
