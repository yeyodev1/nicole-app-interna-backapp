import { Schema, model, Document, Types } from "mongoose";

export interface IOrderProduct {
  _id?: Types.ObjectId;
  name: string;
  quantity: number;
  price: number;
  contifico_id?: string;
  produced?: number;
  productionStatus?: "PENDING" | "IN_PROCESS" | "COMPLETED";
  productionNotes?: string;
  isCourtesy?: boolean;
}

export interface IDispatchItem {
  productId: string;
  name: string;
  quantitySent: number;
  quantityReceived?: number;
  itemStatus?: "OK" | "MISSING" | "DAMAGED" | "BAD_CONDITION";
  itemNote?: string;
}

export interface IDispatch {
  _id: Types.ObjectId;
  reportedAt: Date;
  modifiedAt: Date;
  destination: string;
  items: IDispatchItem[];
  notes?: string;
  reportedBy: string;

  // Reception Fields
  receptionStatus: "PENDING" | "RECEIVED" | "PROBLEM";
  receivedAt?: Date;
  receivedBy?: string;
  receptionNotes?: string;
}

/** Datos propios de un pedido creado desde la tienda online. */
export interface IWebOrder {
  /** `_id` de la orden en la tienda. Llave de idempotencia. */
  externalId: string;
  /** Código visible para el cliente, ej. "NP-7K2Q9X". */
  code?: string;
  customerEmail?: string;
  customerIdNumber?: string;
  /** Método de pago tal cual lo manda la tienda: 'Payphone' | 'Transferencia'. */
  paymentMethod?: string;
  paymentStatus?: "PAID" | "PENDING_VERIFICATION";
  paymentReference?: string;
  deliveryReference?: string;
  /** Km en ruta desde la sucursal de salida (solo delivery). */
  deliveryKm?: number;
  /** Sucursal de salida que eligió la tienda (solo delivery). */
  originBranch?: string;
  /** Foto del comprobante de transferencia que subió el cliente en la tienda (Cloudinary). */
  paymentProofUrl?: string;
  paymentProofAt?: Date;
  /** Último comprobante rechazado desde la app interna (la tienda lo aplica en su cron). Se limpia con uno nuevo. */
  proofRejected?: { reason?: string; at: Date; by?: string };
  receivedAt?: Date;
  managedAt?: Date;
  managedBy?: string;
}

export interface IOrder extends Document {
  deliveryPerson?: {
    name: string;
    identification: string;
    personId?: Types.ObjectId;
  };
  orderDate: Date;
  deliveryDate: Date;
  deliveryTime?: string;
  customerName: string;
  customerPhone: string;
  salesChannel: string;
  products: IOrderProduct[];
  deliveryType: "delivery" | "retiro";
  branch?: string;
  googleMapsLink?: string;
  deliveryAddress?: string;
  totalValue: number;
  deliveryValue: number;
  paymentMethod: string;
  invoiceNeeded: boolean;
  responsible: string;
  /** Vendedor a cargo — es el que sale en la factura de Contífico para comisiones. */
  sellerName?: string;
  /** Cédula del vendedor. Llave con la que Contífico identifica a la persona. */
  sellerIdentification?: string;
  createdBy: string;
  updatedBy: string;
  auditLog: Array<{
    user: string;
    action: string;
    at: Date;
    details?: string;
  }>;
  comments?: string;
  invoiceData?: {
    ruc: string;
    businessName: string;
    email: string;
    address: string;
    personType?: 'natural' | 'juridica';
  };
  invoiceStatus?: "PENDING" | "PROCESSED" | "ERROR";
  invoiceError?: string;
  invoiceInfo?: any;
  invoiceSentToSriAt?: Date;
  contificoSource?: 'nicole' | 'sucree';
  productionStage: "PENDING" | "IN_PROCESS" | "FINISHED" | "DELAYED" | "VOID";
  productionNotes: string;
  voidedAt: Date | null;
  settledInIsland: boolean;
  settledIslandName?: string;
  globalDiscountPercentage: number;
  isGlobalCourtesy: boolean;
  skipProduction: boolean;
  exitPoint?: string;

  // Dispatch Fields
  dispatches: IDispatch[];
  dispatchStatus: "NOT_SENT" | "PARTIAL" | "SENT" | "PROBLEM" | "RETURNED";

  paymentDetails?: {
    forma_cobro: string;
    monto: number;
    fecha: string;
    numero_comprobante?: string;
    cuenta_bancaria_id?: string;
    tipo_ping?: string;
    numero_tarjeta?: string;
  };
  payments: Array<{
    forma_cobro: string;
    monto: number;
    fecha: Date;
    numero_comprobante?: string;
    cuenta_bancaria_id?: string;
    tipo_ping?: string;
    numero_tarjeta?: string;
    reference?: string;
    status?: string;
    /** Pedidos web: foto del comprobante de transferencia con la que se confirmó el cobro. */
    comprobanteUrl?: string;
  }>;
  status?: string; // Top level status (e.g. DELIVERED). Pedidos web: PENDIENTE_GESTION → GESTIONADO
  /** Sólo en pedidos que llegan de la tienda online (`/api/web-orders`). */
  webOrder?: IWebOrder;
  createdAt: Date;
  updatedAt: Date;
}

const DispatchSchema = new Schema<IDispatch>({
  reportedAt: { type: Date, default: Date.now },
  modifiedAt: { type: Date, default: Date.now },
  destination: { type: String, required: true },
  items: [
    {
      productId: { type: String, required: true },
      name: { type: String },
      quantitySent: { type: Number, required: true },
      quantityReceived: { type: Number },
      itemStatus: { type: String, enum: ["OK", "MISSING", "DAMAGED", "BAD_CONDITION"], default: "OK" },
      itemNote: { type: String }
    }
  ],
  notes: { type: String },
  reportedBy: { type: String, default: "Producción" },

  // Reception Fields
  receptionStatus: {
    type: String,
    enum: ["PENDING", "RECEIVED", "PROBLEM"],
    default: "PENDING"
  },
  receivedAt: { type: Date },
  receivedBy: { type: String },
  receptionNotes: { type: String }
});

const OrderSchema = new Schema<IOrder>(
  {
    deliveryPerson: {
      name: { type: String },
      identification: { type: String },
      personId: { type: Schema.Types.ObjectId, ref: "DeliveryPerson" }
    },
    orderDate: { type: Date, required: true },
    deliveryDate: { type: Date, required: true },
    deliveryTime: { type: String, required: false },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    salesChannel: { type: String, required: true },
    products: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        contifico_id: { type: String },
        produced: { type: Number, default: 0 },
        productionStatus: {
          type: String,
          enum: ["PENDING", "IN_PROCESS", "COMPLETED"],
          default: "PENDING"
        },
        productionNotes: { type: String },
        isCourtesy: { type: Boolean, default: false }
      },
    ],
    deliveryType: {
      type: String,
      enum: ["delivery", "retiro"],
      required: true,
    },
    branch: {
      type: String,
      required: false
    },
    googleMapsLink: { type: String },
    deliveryAddress: { type: String },
    totalValue: { type: Number, required: true },
    deliveryValue: { type: Number, default: 0 },
    paymentMethod: { type: String, required: true },
    invoiceNeeded: { type: Boolean, default: false },
    invoiceStatus: {
      type: String,
      enum: ["PENDING", "PROCESSED", "ERROR"],
      default: undefined,
    },
    invoiceError: { type: String, default: undefined },
    responsible: {
      type: String,
      required: true,
    },
    sellerName: { type: String, trim: true },
    sellerIdentification: { type: String, trim: true },
    createdBy: { type: String },
    updatedBy: { type: String },
    auditLog: [
      {
        user: { type: String },
        action: { type: String },
        at: { type: Date, default: Date.now },
        details: { type: String }
      }
    ],
    comments: { type: String },
    invoiceData: {
      ruc: { type: String },
      businessName: { type: String },
      email: { type: String },
      address: { type: String },
      personType: { type: String, enum: ['natural', 'juridica'] },
    },
    invoiceInfo: { type: Schema.Types.Mixed },
    invoiceSentToSriAt: { type: Date, default: undefined },
    contificoSource: { type: String, enum: ['nicole', 'sucree'], default: 'nicole' },

    // Production Fields
    productionStage: {
      type: String,
      enum: ["PENDING", "IN_PROCESS", "FINISHED", "DELAYED", "VOID"],
      default: "PENDING"
    },
    productionNotes: { type: String, default: "" },
    voidedAt: { type: Date, default: null },
    settledInIsland: { type: Boolean, default: false },
    settledIslandName: { type: String },
    globalDiscountPercentage: { type: Number, default: 0 },
    isGlobalCourtesy: { type: Boolean, default: false },
    skipProduction: { type: Boolean, default: false },
    exitPoint: { type: String, default: '' },

    // Dispatch Fields
    dispatches: { type: [DispatchSchema], default: [] },
    dispatchStatus: {
      type: String,
      enum: ["NOT_SENT", "PARTIAL", "SENT", "PROBLEM", "RETURNED"],
      default: "NOT_SENT"
    },

    status: { type: String }, // New top level status

    // Pedido de la tienda online (sólo existe en pedidos creados por /api/web-orders)
    webOrder: {
      externalId: { type: String },
      code: { type: String },
      customerEmail: { type: String },
      customerIdNumber: { type: String },
      paymentMethod: { type: String },
      paymentStatus: { type: String, enum: ["PAID", "PENDING_VERIFICATION"] },
      paymentReference: { type: String },
      deliveryReference: { type: String },
      deliveryKm: { type: Number },
      originBranch: { type: String },
      paymentProofUrl: { type: String },
      paymentProofAt: { type: Date },
      proofRejected: {
        type: new Schema({ reason: String, at: Date, by: String }, { _id: false }),
        default: undefined,
      },
      receivedAt: { type: Date },
      managedAt: { type: Date },
      managedBy: { type: String },
    },

    paymentDetails: {
      forma_cobro: String,
      monto: Number,
      fecha: String,
      numero_comprobante: String,
      cuenta_bancaria_id: String,
      tipo_ping: String,
      numero_tarjeta: String
    },
    payments: [
      {
        forma_cobro: { type: String, required: true },
        monto: { type: Number, required: true },
        fecha: { type: Date, default: Date.now },
        numero_comprobante: String,
        cuenta_bancaria_id: String,
        tipo_ping: String,
        numero_tarjeta: String,
        reference: String, // Contifico or external reference
        comprobanteUrl: String, // Pedidos web: comprobante de la transferencia confirmada
        status: { type: String, enum: ['PENDING', 'PAID', 'ERROR'], default: 'PAID' }
      }
    ]
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Idempotencia de la tienda online: un externalId = un pedido. Sparse para que los
// pedidos manuales (sin webOrder) no choquen entre sí.
OrderSchema.index({ "webOrder.externalId": 1 }, { unique: true, sparse: true });

export const OrderModel = model<IOrder>("Order", OrderSchema);
