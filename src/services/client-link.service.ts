import { randomBytes } from "crypto";
import axios from "axios";
import { Types } from "mongoose";
import { models } from "../models";
import CustomError from "../errors/customError.error";
import { EmailService, escapeHtml } from "./email.service";
import { ContificoService } from "./contifico.service";
import { issueInvoiceNow } from "./invoice-issue.service";
import type { NotificationType } from "../models/notification.model";

/**
 * Link de gestión de entrega (contrato v8).
 *
 * El asesor solo cobra: elige productos, registra el pago y genera un link. El
 * cliente abre `<tienda>/pedido/<token>` y completa quién recibe, dirección o
 * isla, fecha, hora, notas y factura. La tienda valida la regla de fechas y
 * calcula el km; aquí se guarda, se manda a producción y se factura.
 *
 * Facturación:
 *  - El cliente pide factura → se emite al confirmar.
 *  - No la pide (o no llena el link en 48 h): total < $50 → Consumidor Final;
 *    total ≥ $50 → aviso al asesor (el SRI no permite Consumidor Final desde $50).
 */

export const CLIENT_LINK_TTL_DAYS = 7;
export const CLIENT_LINK_INVOICE_DEADLINE_HOURS = 48;
export const CLIENT_LINK_REMINDER_HOURS = 24;
/** Tope del SRI para facturar a Consumidor Final. */
export const CONSUMIDOR_FINAL_MAX_TOTAL = 50;
export const CDP_BRANCH = "Centro de Producción";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CONSUMIDOR_FINAL_RUC = "9999999999999";

const TIENDA_PUBLIC_URL = () => (process.env.TIENDA_PUBLIC_URL || "https://nicole.com.ec").replace(/\/+$/, "");
const FRONTEND_URL = () => (process.env.FRONTEND_URL || "https://app.nicole.com.ec").replace(/\/+$/, "");

// Perezoso: Resend lanza al construirse sin RESEND_API_KEY.
let emailServiceInstance: EmailService | null = null;
const emailService = {
  sendBranded: (params: Parameters<EmailService["sendBranded"]>[0]) => {
    if (!process.env.RESEND_API_KEY) return Promise.resolve(false);
    emailServiceInstance ??= new EmailService();
    return emailServiceInstance.sendBranded(params);
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
const firstName = (name?: string) => String(name || "").trim().split(/\s+/)[0] || "";

export function newClientLinkToken(): string {
  return randomBytes(16).toString("hex");
}

export function clientLinkUrl(token: string): string {
  return `${TIENDA_PUBLIC_URL()}/pedido/${token}`;
}

function orderUrl(orderId: unknown): string {
  return `${FRONTEND_URL()}/orders/${orderId}`;
}

/** PENDING vencido se muestra como EXPIRED; no se guarda, se calcula. */
export function clientLinkStatus(link: any): "PENDING" | "COMPLETED" | "EXPIRED" {
  if (link.status === "COMPLETED") return "COMPLETED";
  return new Date(link.expiresAt).getTime() < Date.now() ? "EXPIRED" : "PENDING";
}

/** "YYYY-MM-DD" de un deliveryDate guardado como medianoche UTC. */
function ymd(date?: Date | null): string | null {
  if (!date) return null;
  return new Date(date).toISOString().slice(0, 10);
}

function todayInGuayaquil(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
}

function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// ─── Creación (lo llama createOrder) ────────────────────────────────────────

export interface ClientLinkInput {
  plannedType?: unknown;
  customerEmail?: unknown;
}

/**
 * Prepara `orderData` de createOrder para el modo link. Muta y devuelve los
 * datos; lanza CustomError 400 si algo no cuadra.
 */
export function applyClientLinkMode(orderData: any, advisor: any): void {
  const input: ClientLinkInput = orderData.clientLink || {};
  const plannedType = input.plannedType === "retiro" || input.plannedType === "pickup" ? "retiro" : input.plannedType === "delivery" ? "delivery" : null;
  if (!plannedType) throw new CustomError("Elige si el pedido es entrega a domicilio o retiro en isla.", 400);

  const phone = String(orderData.customerPhone || "").replace(/\D/g, "");
  if (phone.length < 9) throw new CustomError("El WhatsApp del cliente es obligatorio para mandarle el link.", 400);

  const customerEmail = str(input.customerEmail, 200).toLowerCase();
  if (customerEmail && !isEmail(customerEmail)) throw new CustomError("El correo del cliente no es válido.", 400);

  const hasDeliveryLine = (orderData.products || []).some((p: any) => /delivery|env[ií]o/i.test(String(p.name || "")));
  if (plannedType === "retiro" && hasDeliveryLine) {
    throw new CustomError("Un pedido de retiro no lleva envío. Quita la línea de Delivery o cámbialo a entrega.", 400);
  }

  // Basta el WhatsApp: si el asesor no puso nombre, el cliente lo escribe en el link.
  const buyerName = str(orderData.customerName, 120);
  orderData.customerName = buyerName || `Cliente ${phone}`;

  const now = new Date();
  orderData.clientLink = {
    token: newClientLinkToken(),
    status: "PENDING",
    plannedType,
    estimatedDeliveryValue: 0, // se completa después de calcular deliveryValue
    ...(customerEmail ? { customerEmail } : {}),
    buyer: { name: buyerName, phone },
    advisorUserId: advisor?._id || advisor?.id ? String(advisor._id || advisor.id) : undefined,
    advisorName: advisor?.name,
    advisorEmail: advisor?.email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLIENT_LINK_TTL_DAYS * DAY_MS),
    invoiceDeadlineAt: new Date(now.getTime() + CLIENT_LINK_INVOICE_DEADLINE_HOURS * HOUR_MS),
  };

  // Lo de la entrega lo pone el cliente. La factura también: así no se pide dos veces.
  orderData.customerPhone = phone;
  orderData.deliveryType = plannedType;
  orderData.deliveryDate = null;
  delete orderData.deliveryTime;
  delete orderData.deliveryAddress;
  delete orderData.googleMapsLink;
  delete orderData.invoiceData;
  orderData.invoiceNeeded = false;
  orderData.branch = plannedType === "delivery" ? CDP_BRANCH : undefined;
  orderData.productionStage = "AWAITING_CLIENT";
  orderData.skipProduction = false;
}

export function clientWhatsappMessage(order: any): string {
  const link = order.clientLink;
  const items = (order.products || [])
    .filter((p: any) => !/delivery|env[ií]o/i.test(String(p.name || "")))
    .map((p: any) => `• ${p.quantity} x ${p.name}`)
    .join("\n");
  const what = link.plannedType === "delivery" ? "la dirección de entrega (con el pin en el mapa)" : "la tienda donde lo retiras";
  return [
    `¡Hola${firstName(link.buyer?.name) ? ` ${firstName(link.buyer?.name)}` : ""}! Gracias por tu compra en Nicole Pastry Arts 💜`,
    "",
    `Recibimos tu pago de ${money(order.totalValue)}:`,
    items,
    "",
    `Ahora completa en este link ${what}, la fecha y hora, y tus datos si necesitas factura:`,
    clientLinkUrl(link.token),
    "",
    "Entregamos desde el día siguiente, de 11h00 a 18h00. El link vence en 7 días.",
  ].join("\n");
}

// ─── Vista pública (tienda) ─────────────────────────────────────────────────

export async function findOrderByToken(token: string): Promise<any> {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new CustomError("Este link no existe.", 404);
  const order: any = await models.orders.findOne({ "clientLink.token": token });
  if (!order) throw new CustomError("Este link no existe.", 404);
  return order;
}

export function publicClientLinkView(order: any) {
  const link = order.clientLink;
  const status = clientLinkStatus(link);
  const isDeliveryLine = (p: any) => /delivery|env[ií]o/i.test(String(p.name || ""));
  const invoiceStatus = order.invoiceStatus || null;
  const invoiceIsCF = String(order.invoiceData?.ruc || "") === CONSUMIDOR_FINAL_RUC;

  return {
    status,
    orderNumber: order.orderNumber || null,
    buyerName: firstName(link.buyer?.name),
    /** El WhatsApp con el que se vendió: el cliente lo ve pero no lo cambia. */
    buyerPhone: link.buyer?.phone || order.customerPhone,
    /** false → el link pide el nombre del cliente (el asesor solo puso el WhatsApp). */
    buyerNameKnown: !!str(link.buyer?.name),
    plannedType: link.plannedType,
    items: (order.products || [])
      .filter((p: any) => !isDeliveryLine(p))
      .map((p: any) => ({ id: String(p._id), name: p.name, quantity: p.quantity, note: p.customerNote || null })),
    totalPaid: Number(order.totalValue) || 0,
    estimatedDeliveryValue: Number(link.estimatedDeliveryValue) || 0,
    expiresAt: link.expiresAt,
    // Ya facturado (p. ej. a Consumidor Final por vencer el plazo): el link no ofrece factura.
    invoiceAvailable: invoiceStatus !== "PROCESSED",
    invoiceStatus,
    completed:
      status === "COMPLETED"
        ? {
            deliveryType: order.deliveryType,
            branch: order.deliveryType === "retiro" ? order.branch || null : null,
            address: order.deliveryType === "delivery" ? link.deliveryAddressRaw || order.deliveryAddress || null : null,
            reference: link.deliveryReference || null,
            date: ymd(order.deliveryDate),
            time: order.deliveryTime || null,
            recipient: { name: order.customerName, phone: order.customerPhone },
            invoice: {
              needed: !!order.invoiceData?.ruc && !invoiceIsCF,
              businessName: invoiceIsCF ? null : order.invoiceData?.businessName || null,
              ruc: invoiceIsCF ? null : order.invoiceData?.ruc || null,
            },
            notes: link.clientNotes || null,
          }
        : null,
  };
}

// ─── Completar (tienda) ─────────────────────────────────────────────────────

function parseInvoice(raw: any, fallbackPhone: string) {
  if (!raw || raw.needed !== true) return null;
  const ruc = String(raw.ruc || "").replace(/\D/g, "");
  if (ruc.length !== 10 && ruc.length !== 13) throw new CustomError("La cédula debe tener 10 dígitos o el RUC 13.", 400);
  const businessName = str(raw.businessName, 200);
  if (!businessName) throw new CustomError("Escribe el nombre o la razón social de la factura.", 400);
  const email = str(raw.email, 200).toLowerCase();
  if (!isEmail(email)) throw new CustomError("Escribe un correo válido para enviarte la factura.", 400);
  const phone = String(raw.phone || "").replace(/\D/g, "") || fallbackPhone;
  return {
    ruc,
    businessName,
    email,
    address: str(raw.address, 300) || "Guayaquil",
    personType: raw.personType === "juridica" ? "juridica" : "natural",
    ...(phone ? { phone } : {}),
  };
}

export async function completeClientLink(token: string, body: any) {
  const order: any = await findOrderByToken(token);
  const link = order.clientLink;
  const status = clientLinkStatus(link);
  if (status === "COMPLETED") throw new CustomError("Este pedido ya fue confirmado. Si necesitas un cambio, escríbele a tu asesor.", 409);
  if (status === "EXPIRED") throw new CustomError("Este link venció. Escríbele a tu asesor para que te envíe uno nuevo.", 410);

  if (!body || typeof body !== "object") throw new CustomError("Datos inválidos.", 400);
  if (body.acceptedTerms !== true) throw new CustomError("Debes aceptar que la dirección y el pin son correctos.", 400);
  if (body.deliveryType !== link.plannedType) {
    throw new CustomError(
      link.plannedType === "delivery" ? "Este pedido es para entrega a domicilio." : "Este pedido es para retiro en tienda.",
      400
    );
  }

  // Fecha y hora: la tienda valida la regla del admin; aquí solo que no sea pasada.
  const date = str(body.date, 10);
  const time = str(body.time, 5);
  if (!isValidYmd(date)) throw new CustomError("Elige una fecha de entrega válida.", 400);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new CustomError("Elige un horario válido.", 400);
  if (date <= todayInGuayaquil()) throw new CustomError("No hacemos entregas el mismo día. Elige desde mañana.", 400);

  // Nombre del cliente: obligatorio si el asesor solo puso el WhatsApp. El WhatsApp no se cambia.
  const buyerNameInput = str(body.buyer?.name, 120);
  if (!str(link.buyer?.name)) {
    if (!buyerNameInput) throw new CustomError("Escribe tu nombre.", 400);
    link.buyer = { name: buyerNameInput, phone: link.buyer?.phone || order.customerPhone };
  }

  // "Yo mismo recibo": recibe el mismo cliente, con su WhatsApp.
  const selfReceives = body.recipient?.self === true;
  const recipientName = selfReceives ? str(link.buyer?.name, 120) : str(body.recipient?.name, 120);
  const recipientPhone = selfReceives
    ? String(link.buyer?.phone || "").replace(/\D/g, "")
    : String(body.recipient?.phone || "").replace(/\D/g, "");
  if (!recipientName) throw new CustomError("Escribe el nombre de quien recibe.", 400);
  if (recipientPhone.length < 9) throw new CustomError("Escribe un teléfono válido de quien recibe.", 400);

  const email = str(body.email, 200).toLowerCase();
  if (email && !isEmail(email)) throw new CustomError("El correo no es válido.", 400);

  const notes = str(body.notes, 1000);
  const reference = str(body.reference, 300);

  if (link.plannedType === "delivery") {
    const address = str(body.address, 400);
    // typeof: Number(null) daría 0 y un pin vacío pasaría como válido.
    const lat = typeof body.lat === "number" ? body.lat : NaN;
    const lng = typeof body.lng === "number" ? body.lng : NaN;
    if (!address) throw new CustomError("Escribe la dirección de entrega.", 400);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new CustomError("Marca el punto exacto de entrega en el mapa.", 400);
    }
    order.deliveryAddress = reference ? `${address} · Ref: ${reference}` : address;
    order.googleMapsLink = str(body.googleMapsLink, 500) || `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    order.branch = str(body.originBranch, 80) || CDP_BRANCH;
    link.lat = lat;
    link.lng = lng;
    link.deliveryAddressRaw = address;
    if (Number.isFinite(Number(body.deliveryKm))) link.deliveryKm = Number(body.deliveryKm);
  } else {
    const branch = str(body.branch, 80);
    if (!branch) throw new CustomError("Elige la tienda donde retiras.", 400);
    if (/centro|producc/i.test(branch)) throw new CustomError("El Centro de Producción no es punto de retiro. Elige una tienda.", 400);
    order.branch = branch;
  }
  link.deliveryReference = reference || undefined;

  // Notas por producto (solo ids de este pedido).
  const notesById = new Map<string, string>();
  for (const n of Array.isArray(body.itemNotes) ? body.itemNotes : []) {
    const note = str(n?.note, 300);
    if (note && typeof n?.id === "string") notesById.set(n.id, note);
  }
  for (const p of order.products) {
    const note = notesById.get(String(p._id));
    if (note) p.customerNote = note;
  }

  // Quién recibe pasa a customerName/Phone (motorizado, lista, WhatsApp), igual que la tienda v7.
  const buyer = link.buyer;
  order.customerName = recipientName;
  order.customerPhone = recipientPhone;
  const extra = [
    buyer.name && buyer.name !== recipientName ? `Compra: ${buyer.name} · Recibe: ${recipientName}` : "",
    notes ? `Nota del cliente: ${notes}` : "",
  ].filter(Boolean);
  if (extra.length) order.comments = [order.comments, ...extra].filter(Boolean).join("\n");
  link.clientNotes = notes || undefined;
  if (email && !link.customerEmail) link.customerEmail = email;

  const [y, m, d] = date.split("-").map(Number);
  order.deliveryDate = new Date(Date.UTC(y, m - 1, d));
  order.deliveryTime = time;
  order.productionStage = order.skipProduction ? "FINISHED" : "PENDING";

  // Factura: solo si todavía no se emitió (p. ej. Consumidor Final por plazo vencido).
  const alreadyInvoiced = order.invoiceStatus === "PROCESSED";
  const invoice = alreadyInvoiced ? null : parseInvoice(body.invoice, recipientPhone);
  if (invoice) {
    order.invoiceData = invoice;
    order.invoiceNeeded = true;
    order.invoiceStatus = "PENDING";
    link.invoiceDeadlineHandled = "CLIENT_DATA";
  }

  link.status = "COMPLETED";
  link.completedAt = new Date();
  link.acceptedTermsAt = new Date();
  order.markModified("clientLink");
  order.auditLog.push({
    user: "Cliente (link)",
    action: "Entrega gestionada por el cliente",
    at: new Date(),
    details: `${order.deliveryType === "delivery" ? "Delivery" : `Retiro en ${order.branch}`} · ${date} ${time}${invoice ? ` · Factura a ${invoice.businessName}` : ""}`,
  });
  order.updatedBy = "Cliente (link)";
  await order.save();

  // Factura y avisos después de guardar: si fallan, la entrega ya quedó registrada.
  let invoiceResult: { ok: boolean; error?: string } | null = null;
  if (invoice) {
    invoiceResult = await issueInvoiceNow(String(order._id));
  } else if (!alreadyInvoiced && !order.invoiceInfo?.id) {
    invoiceResult = await resolveNoInvoiceData(order);
  }

  const when = `${date.split("-").reverse().join("/")} ${time}`;
  const where = order.deliveryType === "delivery" ? `delivery a ${link.deliveryAddressRaw}` : `retiro en ${order.branch}`;
  await notifyAdvisor(order, {
    type: "CLIENT_LINK_COMPLETED",
    title: `${buyer.name || recipientName} completó su pedido`,
    message: `${where} · ${when}${invoice ? ` · factura a ${invoice.businessName}` : ""}`,
    email: true,
  });
  if (invoiceResult && !invoiceResult.ok && invoiceResult.error) {
    await notifyAdvisor(order, {
      type: "CLIENT_LINK_INVOICE_ERROR",
      title: "No se pudo emitir la factura",
      message: `${invoiceResult.error}. Se reintenta esta noche; revísala en el pedido.`,
      email: true,
    });
  }

  return { ok: true, status: "COMPLETED" as const };
}

/**
 * El cliente no quiere factura (o no llenó a tiempo): < $50 → Consumidor Final;
 * ≥ $50 → aviso al asesor. Marca `invoiceDeadlineHandled` para no repetir.
 */
async function resolveNoInvoiceData(order: any): Promise<{ ok: boolean; error?: string } | null> {
  const link = order.clientLink;
  if (link.invoiceDeadlineHandled) return null;
  const total = Number(order.totalValue) || 0;
  if (total <= 0 || order.isGlobalCourtesy || order.settledInIsland) {
    link.invoiceDeadlineHandled = "CLIENT_DATA";
    order.markModified("clientLink");
    await order.save();
    return null;
  }

  if (total < CONSUMIDOR_FINAL_MAX_TOTAL) {
    order.invoiceData = {
      ruc: CONSUMIDOR_FINAL_RUC,
      businessName: "Consumidor Final",
      email: link.customerEmail || "noname@noname.com",
      address: link.deliveryAddressRaw || "Guayaquil",
      personType: "natural",
      phone: link.buyer?.phone || order.customerPhone,
    };
    order.invoiceNeeded = true;
    order.invoiceStatus = "PENDING";
    link.invoiceDeadlineHandled = "CONSUMIDOR_FINAL";
    order.markModified("clientLink");
    order.auditLog.push({
      user: "Sistema",
      action: "Factura a Consumidor Final",
      at: new Date(),
      details: `Sin datos de factura del cliente y total ${money(total)} < ${money(CONSUMIDOR_FINAL_MAX_TOTAL)}.`,
    });
    await order.save();
    return issueInvoiceNow(String(order._id));
  }

  link.invoiceDeadlineHandled = "ADVISOR_NOTIFIED";
  order.markModified("clientLink");
  await order.save();
  await notifyAdvisor(order, {
    type: "CLIENT_LINK_INVOICE_NEEDED",
    title: `Faltan datos de factura · ${link.buyer?.name || order.customerName}`,
    message: `El pedido es de ${money(total)} (desde ${money(CONSUMIDOR_FINAL_MAX_TOTAL)} no se puede facturar a Consumidor Final). Pide la cédula o RUC al cliente y cárgala en el pedido.`,
    email: true,
  });
  return null;
}

// ─── Avisos al asesor ───────────────────────────────────────────────────────

/** Asesor del link; si ya no existe, los SALES_MANAGER y superadmin de la cuenta. */
async function advisorRecipients(order: any): Promise<Array<{ _id: Types.ObjectId; email?: string }>> {
  const link = order.clientLink;
  if (link?.advisorUserId && Types.ObjectId.isValid(link.advisorUserId)) {
    const user: any = await models.users.findById(link.advisorUserId).select("_id email").lean();
    if (user) return [user];
  }
  return models.users
    .find({ role: { $in: ["SALES_MANAGER", "superadmin"] } })
    .select("_id email")
    .lean() as any;
}

export async function notifyAdvisor(
  order: any,
  params: { type: NotificationType; title: string; message: string; email?: boolean }
): Promise<void> {
  try {
    const recipients = await advisorRecipients(order);
    if (!recipients.length) return;
    await models.notifications.insertMany(
      recipients.map((u) => ({ user: u._id, type: params.type, title: params.title, message: params.message, orderId: order._id }))
    );
    if (params.email) {
      const emails = recipients.map((u) => u.email).filter((e): e is string => !!e);
      await emailService.sendBranded({
        to: emails,
        subject: `${params.title} — Nicole Pastry`,
        bodyHtml: `<p><strong>${escapeHtml(params.title)}</strong></p><p>${escapeHtml(params.message)}</p>`,
        cta: { label: "Ver pedido", url: orderUrl(order._id) },
      });
    }
  } catch (err) {
    console.error(`⚠️ [${order?._id}] Aviso al asesor no enviado:`, err);
  }
}

// ─── Cron (cada hora) ───────────────────────────────────────────────────────

const contifico = { nicole: new ContificoService("nicole"), sucree: new ContificoService("sucree") };

/** Recordatorios, plazo de factura de 48 h y correo con el PDF de la factura. */
export async function runClientLinkCron() {
  const now = Date.now();
  const result = { reminded: 0, advisorsNotified: 0, consumidorFinal: 0, invoiceRequests: 0, invoiceEmails: 0, errors: 0 };

  // 1. 24 h sin completar: recordatorio al cliente (si dejó correo) y aviso al asesor.
  const stale = await models.orders
    .find({
      "clientLink.status": "PENDING",
      "clientLink.createdAt": { $lte: new Date(now - CLIENT_LINK_REMINDER_HOURS * HOUR_MS) },
      "clientLink.expiresAt": { $gt: new Date(now) },
      "clientLink.advisorRemindedAt": { $exists: false },
      voidedAt: null,
    })
    .limit(50);
  for (const order of stale as any[]) {
    try {
      const link = order.clientLink;
      if (link.customerEmail) {
        const sent = await emailService.sendBranded({
          to: link.customerEmail,
          subject: "Completa los datos de tu pedido — Nicole Pastry",
          bodyHtml: `<p>Hola ${escapeHtml(firstName(link.buyer?.name))},</p>
            <p>Ya recibimos tu pago de <strong>${money(order.totalValue)}</strong>. Solo falta que nos digas ${
              link.plannedType === "delivery" ? "dónde entregamos tu pedido" : "en qué tienda lo retiras"
            } y la fecha.</p>
            <p>Entregamos desde el día siguiente, de 11h00 a 18h00. El link vence el ${new Date(link.expiresAt).toLocaleDateString("es-EC", { timeZone: "America/Guayaquil" })}.</p>`,
          cta: { label: "Completar mi pedido", url: clientLinkUrl(link.token) },
        });
        if (sent) {
          link.clientRemindedAt = new Date();
          result.reminded++;
        }
      }
      link.advisorRemindedAt = new Date();
      order.markModified("clientLink");
      await order.save();
      await notifyAdvisor(order, {
        type: "CLIENT_LINK_PENDING",
        title: `${link.buyer?.name || order.customerName} no ha completado su link`,
        message: `Lleva más de ${CLIENT_LINK_REMINDER_HOURS} h. Escríbele por WhatsApp para que elija ${
          link.plannedType === "delivery" ? "la dirección" : "la tienda"
        } y la fecha.`,
        email: true,
      });
      result.advisorsNotified++;
    } catch (err) {
      result.errors++;
      console.error(`⚠️ [${order._id}] Recordatorio del link falló:`, err);
    }
  }

  // 2. Plazo de factura vencido sin datos del cliente.
  const overdue = await models.orders
    .find({
      clientLink: { $exists: true },
      "clientLink.invoiceDeadlineAt": { $lte: new Date(now) },
      "clientLink.invoiceDeadlineHandled": { $exists: false },
      invoiceStatus: { $ne: "PROCESSED" },
      "invoiceInfo.id": { $exists: false },
      voidedAt: null,
      productionStage: { $ne: "VOID" },
    })
    .limit(10);
  for (const order of overdue as any[]) {
    try {
      const before = Number(order.totalValue) || 0;
      const r = await resolveNoInvoiceData(order);
      if (before < CONSUMIDOR_FINAL_MAX_TOTAL) result.consumidorFinal++;
      else result.invoiceRequests++;
      if (r && !r.ok) result.errors++;
    } catch (err) {
      result.errors++;
      console.error(`⚠️ [${order._id}] Plazo de factura del link falló:`, err);
    }
  }

  // 3. Factura autorizada → PDF por correo al cliente (una sola vez).
  const toEmail = await models.orders
    .find({
      clientLink: { $exists: true },
      "clientLink.invoiceEmailedAt": { $exists: false },
      invoiceStatus: "PROCESSED",
      "invoiceInfo.id": { $exists: true },
      invoiceSentToSriAt: { $lte: new Date(now - 10 * 60 * 1000), $gte: new Date(now - 10 * DAY_MS) },
    })
    .limit(10);
  for (const order of toEmail as any[]) {
    try {
      const link = order.clientLink;
      const invoiceEmail = String(order.invoiceData?.email || "");
      const to = invoiceEmail && invoiceEmail !== "noname@noname.com" ? invoiceEmail : link.customerEmail;
      if (!to) {
        link.invoiceEmailedAt = new Date(0); // sin correo: no se vuelve a intentar
        order.markModified("clientLink");
        await order.save();
        continue;
      }
      const svc = order.contificoSource === "sucree" ? contifico.sucree : contifico.nicole;
      const doc: any = await svc.getDocument(order.invoiceInfo.id);
      if (!doc?.autorizacion || !doc?.url_ride) continue; // todavía no autorizada: próxima hora
      const pdf = await axios.get(doc.url_ride, { responseType: "arraybuffer", timeout: 20_000 });
      const sent = await emailService.sendBranded({
        to,
        subject: `Tu factura ${doc.documento || ""} — Nicole Pastry`.replace("  ", " "),
        bodyHtml: `<p>Hola ${escapeHtml(firstName(order.invoiceData?.businessName || link.buyer?.name))},</p>
          <p>Adjuntamos tu factura electrónica por <strong>${money(order.totalValue)}</strong>. ¡Gracias por elegir Nicole Pastry!</p>`,
        attachments: [{ filename: `factura-${doc.documento || order._id}.pdf`, content: Buffer.from(pdf.data) }],
      });
      if (sent) {
        link.invoiceEmailedAt = new Date();
        order.markModified("clientLink");
        await order.save();
        result.invoiceEmails++;
      }
    } catch (err) {
      result.errors++;
      console.error(`⚠️ [${order._id}] Correo de factura del link falló:`, err);
    }
  }

  return result;
}
