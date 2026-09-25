import { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { models } from "../models";
import { ContificoService } from "../services/contifico.service";
import { isPrecioIvaIncluido, CONTIFICO_DELIVERY_ID } from "../config/precio-final.config";
import { CONTIFICO_CUENTA_BANCARIA_TRA } from "../config/contifico-cobro.config";
import { normalizeString } from "../utils/string.utils";

/**
 * Pedidos que llegan de la tienda online (nicole-tienda-backapp).
 *
 * Contrato: docs/api-contract.md del backapp de la tienda, sección
 * "Integración con la app interna". Rutas protegidas con `x-api-key`
 * (ver webOrdersApiKey.middleware.ts), sin JWT.
 *
 * El pedido entra como cualquier otro de la app interna, con canal
 * "Tienda Online" y `status: "PENDIENTE_GESTION"` para que el equipo lo
 * revise, lo facture y lo mande a producción como siempre. No se toca
 * `invoiceStatus`: la facturación sigue siendo manual / por el cron habitual.
 */

export const WEB_ORDER_CHANNEL = "Tienda Online";
export const WEB_ORDER_STATUS_PENDING = "PENDIENTE_GESTION";
export const WEB_ORDER_STATUS_MANAGED = "GESTIONADO";

const IVA_RATE = 1.15;
/** Si Contífico tarda más que esto, el pedido se guarda sin emparejar productos. */
const CONTIFICO_MATCH_TIMEOUT_MS = 8000;

const nicoleContificoService = new ContificoService("nicole");

type WebPaymentStatus = "PAID" | "PENDING_VERIFICATION";

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optionalString = (v: unknown): string | undefined => (isNonEmptyString(v) ? v.trim() : undefined);
/** URL del comprobante de transferencia (Cloudinary de la tienda): solo https. */
const isProofUrl = (v: unknown): v is string => isNonEmptyString(v) && /^https:\/\/\S+$/.test(v.trim()) && v.length <= 1000;
const PROOF_RECEIVED = "Comprobante de transferencia recibido";

function paymentMethodLabel(method: string, status: WebPaymentStatus): string {
  if (method === "Payphone") return "Payphone (pagado)";
  return status === "PAID" ? "Transferencia (verificada)" : "Transferencia (por verificar)";
}

/** Hoy en Guayaquil como "YYYY-MM-DD" (mismo formato que manda el front en paymentDetails.fecha). */
function todayInGuayaquil(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
}

/** Procesador con el que se registra en Contífico un cobro de Payphone (tarjeta). */
const PAYPHONE_TIPO_PING = process.env.CONTIFICO_PAYPHONE_TIPO_PING || "D";

/** Datos de la tarjeta que la tienda recibe de Payphone (sin datos sensibles). */
interface WebCardInfo {
  last4?: string;
  authorizationCode?: string;
}

/**
 * Pedido web pagado: se registra como cobro (igual que registerCollection) para que
 * el saldo quede en 0 y, al facturar, el cobro llegue solo a Contífico.
 *  - Transferencia → TRA a la cuenta de Banco Guayaquil.
 *  - Payphone → Tarjeta (TC) con los últimos 4 dígitos y la autorización de Payphone.
 * Solo si todavía no hay cobros: nunca duplica uno registrado a mano.
 */
export function applyWebPayment(order: any, method: string, reference: string, card: WebCardInfo = {}): boolean {
  if ((order.payments || []).length > 0) return false;
  const monto = Number(order.totalValue) || 0;
  if (monto <= 0) return false;

  const base =
    method === "Payphone"
      ? {
          forma_cobro: "TC",
          monto,
          numero_comprobante: card.authorizationCode || reference,
          tipo_ping: PAYPHONE_TIPO_PING,
          ...(card.last4 ? { numero_tarjeta: card.last4 } : {}),
        }
      : {
          forma_cobro: "TRA",
          monto,
          numero_comprobante: reference,
          cuenta_bancaria_id: CONTIFICO_CUENTA_BANCARIA_TRA,
        };

  order.paymentDetails = { ...base, fecha: todayInGuayaquil() };
  order.payments = [{ ...base, fecha: new Date(), status: "PAID" }];
  return true;
}

/** Deja el pedido web pagado en cola para la facturación automática (cron nocturno). */
export function queueWebInvoice(order: any) {
  if (order.invoiceNeeded && order.invoiceData?.ruc && order.invoiceStatus !== "PROCESSED") {
    order.invoiceStatus = "PENDING";
  }
}

/**
 * Sin datos de factura, el pedido web se factura a Consumidor Final (SRI
 * 9999999999999) con el correo del cliente, para que le llegue su comprobante.
 */
function consumidorFinalInvoiceData(email: string, address: string, phone?: string) {
  return {
    ruc: "9999999999999",
    businessName: "Consumidor Final",
    email,
    address: address || "Guayaquil",
    personType: "natural",
    ...(phone ? { phone } : {}),
  };
}

/** "YYYY-MM-DD" que corresponde a una fecha real del calendario. */
function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Valida el body de POST /web-orders. Devuelve la lista de errores (vacía si todo ok).
 */
function validateWebOrderBody(body: any): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return ["El cuerpo de la petición debe ser un objeto JSON."];

  if (!isNonEmptyString(body.externalId)) errors.push("externalId es obligatorio.");
  if (!isNonEmptyString(body.orderCode)) errors.push("orderCode es obligatorio.");
  if (!isNonEmptyString(body.customerName)) errors.push("customerName es obligatorio.");
  if (!isNonEmptyString(body.customerPhone)) errors.push("customerPhone es obligatorio.");
  if (!isNonEmptyString(body.customerEmail)) errors.push("customerEmail es obligatorio.");

  if (body.deliveryType !== "retiro" && body.deliveryType !== "delivery") {
    errors.push("deliveryType debe ser 'retiro' o 'delivery'.");
  }
  if (body.deliveryType === "delivery" && !isNonEmptyString(body.deliveryAddress)) {
    errors.push("deliveryAddress es obligatorio para pedidos con delivery.");
  }

  if (!isNonEmptyString(body.deliveryDate) || !isValidDateString(body.deliveryDate)) {
    errors.push("deliveryDate debe tener el formato YYYY-MM-DD.");
  }
  if (!isNonEmptyString(body.deliveryTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.deliveryTime)) {
    errors.push("deliveryTime debe tener el formato HH:mm.");
  }

  if (body.deliveryValue !== undefined && (!isFiniteNumber(body.deliveryValue) || body.deliveryValue < 0)) {
    errors.push("deliveryValue debe ser un número mayor o igual a 0.");
  }
  if (body.deliveryKm !== undefined && body.deliveryKm !== null && (!isFiniteNumber(body.deliveryKm) || body.deliveryKm < 0)) {
    errors.push("deliveryKm debe ser un número mayor o igual a 0.");
  }
  if (body.originBranch !== undefined && body.originBranch !== null && typeof body.originBranch !== "string") {
    errors.push("originBranch debe ser texto.");
  }

  if (!Array.isArray(body.products) || body.products.length === 0) {
    errors.push("products debe tener al menos un producto.");
  } else {
    body.products.forEach((p: any, i: number) => {
      const n = i + 1;
      if (!p || typeof p !== "object") {
        errors.push(`El producto ${n} no es válido.`);
        return;
      }
      if (!isNonEmptyString(p.name)) errors.push(`El producto ${n} no tiene nombre.`);
      if (!isFiniteNumber(p.quantity) || p.quantity <= 0) errors.push(`El producto ${n} debe tener una cantidad mayor a 0.`);
      if (!isFiniteNumber(p.price) || p.price < 0) errors.push(`El producto ${n} debe tener un precio mayor o igual a 0.`);
      if (p.contifico_id !== undefined && p.contifico_id !== null && typeof p.contifico_id !== "string") {
        errors.push(`El contifico_id del producto ${n} debe ser texto.`);
      }
    });
  }

  if (!isFiniteNumber(body.totalValue) || body.totalValue < 0) {
    errors.push("totalValue debe ser un número mayor o igual a 0.");
  }
  if (body.paymentMethod !== "Payphone" && body.paymentMethod !== "Transferencia") {
    errors.push("paymentMethod debe ser 'Payphone' o 'Transferencia'.");
  }
  if (body.paymentStatus !== "PAID" && body.paymentStatus !== "PENDING_VERIFICATION") {
    errors.push("paymentStatus debe ser 'PAID' o 'PENDING_VERIFICATION'.");
  }

  if (body.paymentProofUrl !== undefined && body.paymentProofUrl !== null && body.paymentProofUrl !== "" && !isProofUrl(body.paymentProofUrl)) {
    errors.push("paymentProofUrl debe ser una URL https.");
  }
  if (body.invoiceNeeded !== undefined && typeof body.invoiceNeeded !== "boolean") {
    errors.push("invoiceNeeded debe ser true o false.");
  }
  if (body.invoiceNeeded === true) {
    const inv = body.invoiceData;
    if (!inv || typeof inv !== "object" || !isNonEmptyString(inv.ruc) || !isNonEmptyString(inv.businessName)) {
      errors.push("invoiceData (con ruc y businessName) es obligatorio cuando invoiceNeeded es true.");
    }
    if (inv?.personType !== undefined && inv.personType !== "natural" && inv.personType !== "juridica") {
      errors.push("invoiceData.personType debe ser 'natural' o 'juridica'.");
    }
  }

  return errors;
}

/**
 * Catálogo de Nicole en Contífico (caché de 1 h del servicio). Nunca lanza:
 * si Contífico falla o tarda, devuelve `null` y el pedido se guarda igual.
 */
async function getNicoleCatalogSafe(timeoutMs = CONTIFICO_MATCH_TIMEOUT_MS): Promise<any[] | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([nicoleContificoService.getCachedProducts(), timeout]);
    return Array.isArray(result) ? result : null;
  } catch (error: any) {
    console.warn("⚠️ [web-orders] No se pudo leer el catálogo de Contífico:", error?.message || error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Busca el producto de Contífico cuyo nombre normalizado coincide exacto. Prefiere activos. */
function matchContificoIdByName(catalog: any[], name: string): string | undefined {
  const target = normalizeString(name);
  if (!target) return undefined;
  const matches = catalog.filter((p) => normalizeString(String(p?.nombre ?? "")) === target);
  const active = matches.find((p) => p?.estado !== "I");
  return (active || matches[0])?.id;
}

/**
 * POST /api/web-orders
 * Crea el pedido de la tienda online. Idempotente por `externalId`.
 */
export async function createWebOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body;
    const errors = validateWebOrderBody(body);
    if (errors.length > 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Datos del pedido web inválidos.", errors });
      return;
    }

    const externalId = String(body.externalId).trim();

    const existing = await models.orders.findOne({ "webOrder.externalId": externalId }, { _id: 1 }).lean();
    if (existing) {
      res.status(HttpStatusCode.Ok).send({ id: String(existing._id), status: "already_exists" });
      return;
    }

    const now = new Date();
    const paymentStatus = body.paymentStatus as WebPaymentStatus;
    const deliveryValue = isFiniteNumber(body.deliveryValue) ? body.deliveryValue : 0;

    // 1. Productos: la tienda manda precio final (IVA incluido); la app interna
    //    guarda la base sin IVA, igual que el pvp1 de Contífico. Los ítems de
    //    precio final (Delivery, TORT-001) se guardan tal cual (ver precio-final.config.ts).
    const products: Array<{ name: string; quantity: number; price: number; contifico_id?: string }> =
      body.products.map((p: any) => {
        const name = String(p.name).trim();
        const contifico_id = optionalString(p.contifico_id);
        const finalPrice = Number(p.price);
        const price = isPrecioIvaIncluido({ contifico_id, name })
          ? finalPrice
          : Math.round((finalPrice / IVA_RATE) * 10000) / 10000;
        return { name, quantity: Number(p.quantity), price, ...(contifico_id ? { contifico_id } : {}) };
      });

    if (deliveryValue > 0) {
      // Producto real de Contífico: sin él la factura saldría con el producto de prueba.
      products.push({
        name: "Delivery",
        quantity: 1,
        price: deliveryValue,
        ...(CONTIFICO_DELIVERY_ID ? { contifico_id: CONTIFICO_DELIVERY_ID } : {}),
      });
    }

    // 2. Emparejar con Contífico por nombre los que llegan sin contifico_id.
    const unmatched: string[] = [];
    if (products.some((p) => !p.contifico_id)) {
      const catalog = await getNicoleCatalogSafe();
      for (const p of products) {
        if (p.contifico_id) continue;
        const id = catalog ? matchContificoIdByName(catalog, p.name) : undefined;
        if (id) p.contifico_id = id;
        else unmatched.push(p.name);
      }
    }

    // 3. Comentarios legibles para el equipo.
    const code = String(body.orderCode).trim();
    const customerEmail = String(body.customerEmail).trim();
    const customerIdNumber = optionalString(body.customerIdNumber);
    const deliveryReference = optionalString(body.deliveryReference);
    const paymentReference = optionalString(body.paymentReference);
    const paymentMethod = paymentMethodLabel(body.paymentMethod, paymentStatus);
    // Sucursal de salida y km en ruta que calculó la tienda (solo delivery).
    const isDelivery = body.deliveryType === "delivery";
    const originBranch = isDelivery ? optionalString(body.originBranch) : undefined;
    const deliveryKm = isDelivery && isFiniteNumber(body.deliveryKm) ? body.deliveryKm : undefined;
    const originLine = originBranch
      ? `Sale desde ${originBranch}${deliveryKm !== undefined ? ` · ${deliveryKm} km` : ""}`
      : null;

    // Contrato v7: customerName/customerPhone = quien recibe/retira (motorizado, lista,
    // WhatsApp); buyer* = quien compró. Tiendas anteriores no mandan buyer*.
    const buyerName = optionalString(body.buyerName);
    const buyerPhone = optionalString(body.buyerPhone);
    const recipientName = String(body.customerName).trim();
    const recipientPhone = String(body.customerPhone).trim();
    const contactLine = buyerName || buyerPhone
      ? `Compra: ${[buyerName, buyerPhone].filter(Boolean).join(" · ")} · ${isDelivery ? "Recibe" : "Retira"}: ${recipientName} · ${recipientPhone}`
      : null;

    const commentLines = [
      `Pedido web ${code}`,
      contactLine,
      `Email: ${customerEmail}`,
      customerIdNumber ? `Cédula/RUC: ${customerIdNumber}` : null,
      `Pago: ${paymentMethod}${paymentReference ? ` · Ref. ${paymentReference}` : ""}`,
      optionalString(body.comments) ? `Notas del cliente: ${String(body.comments).trim()}` : null,
      deliveryReference ? `Referencia de entrega: ${deliveryReference}` : null,
      originLine,
    ].filter(Boolean);

    const auditDetails = [
      `Código ${code} · ${body.paymentMethod} (${paymentStatus === "PAID" ? "pagado" : "por verificar"}) · Total $${Number(body.totalValue).toFixed(2)}`,
      unmatched.length > 0 ? `Productos sin código de Contífico (revisar antes de facturar): ${unmatched.join(", ")}` : null,
    ].filter(Boolean).join(". ");

    // 4. deliveryDate: se guarda igual que los pedidos manuales, a la medianoche UTC
    //    del día de entrega (el front manda "YYYY-MM-DD" y Mongoose lo convierte así).
    //    Los filtros por día (getECDateRange) y la vista (parseECTDate) asumen ese formato;
    //    la hora de entrega en hora de Guayaquil vive en `deliveryTime`.
    const deliveryDate = new Date(`${body.deliveryDate}T00:00:00.000Z`);
    const paymentProofUrl = isProofUrl(body.paymentProofUrl) ? body.paymentProofUrl.trim() : undefined;

    const orderData: any = {
      orderDate: now,
      deliveryDate,
      deliveryTime: body.deliveryTime,
      customerName: recipientName,
      customerPhone: recipientPhone,
      salesChannel: WEB_ORDER_CHANNEL,
      products,
      deliveryType: body.deliveryType,
      totalValue: Number(body.totalValue),
      deliveryValue,
      paymentMethod,
      invoiceNeeded: body.invoiceNeeded === true,
      responsible: WEB_ORDER_CHANNEL,
      createdBy: WEB_ORDER_CHANNEL,
      updatedBy: WEB_ORDER_CHANNEL,
      contificoSource: "nicole",
      status: WEB_ORDER_STATUS_PENDING,
      comments: commentLines.join("\n"),
      auditLog: [
        {
          user: WEB_ORDER_CHANNEL,
          action: "Pedido recibido desde la tienda online",
          at: now,
          details: auditDetails,
        },
        ...(paymentProofUrl
          ? [{ user: WEB_ORDER_CHANNEL, action: PROOF_RECEIVED, at: now, details: `Por verificar · ${paymentProofUrl}` }]
          : []),
      ],
      webOrder: {
        externalId,
        code,
        customerEmail,
        customerIdNumber,
        ...(buyerName || buyerPhone
          ? { buyer: { ...(buyerName ? { name: buyerName } : {}), ...(buyerPhone ? { phone: buyerPhone } : {}) } }
          : {}),
        paymentMethod: body.paymentMethod,
        paymentStatus,
        paymentReference,
        deliveryReference,
        ...(deliveryKm !== undefined ? { deliveryKm } : {}),
        ...(originBranch ? { originBranch } : {}),
        ...(paymentProofUrl ? { paymentProofUrl, paymentProofAt: now } : {}),
        receivedAt: now,
      },
    };

    if (body.deliveryType === "retiro") {
      const branch = optionalString(body.branch);
      if (branch) orderData.branch = branch;
    } else {
      orderData.deliveryAddress = String(body.deliveryAddress).trim();
      // Así el pedido se lee "Delivery saliendo de <sucursal>" en la app.
      if (originBranch) orderData.branch = originBranch;
    }
    const googleMapsLink = optionalString(body.googleMapsLink);
    if (googleMapsLink) orderData.googleMapsLink = googleMapsLink;

    if (orderData.invoiceNeeded && body.invoiceData) {
      const inv = body.invoiceData;
      // Contífico necesita correo y dirección del comprador: si la tienda no los manda,
      // se usan los del pedido (en retiro no hay dirección de entrega: "Guayaquil").
      const fallbackAddress = isDelivery ? String(orderData.deliveryAddress || "").trim() : "";
      orderData.invoiceData = {
        ruc: String(inv.ruc ?? "").trim(),
        businessName: String(inv.businessName ?? "").trim(),
        email: String(inv.email ?? "").trim() || customerEmail,
        address: String(inv.address ?? "").trim() || fallbackAddress || "Guayaquil",
        ...(inv.personType ? { personType: inv.personType } : {}),
        // Teléfono de la factura (v7); sin él Contífico usa customerPhone como siempre.
        ...(optionalString(inv.phone) ? { phone: optionalString(inv.phone) } : {}),
      };
    }

    // Sin factura con datos: se factura a Consumidor Final (decisión de Nicole).
    if (!orderData.invoiceNeeded) {
      const fallbackAddress = isDelivery ? String(orderData.deliveryAddress || "").trim() : "";
      orderData.invoiceNeeded = true;
      orderData.invoiceData = consumidorFinalInvoiceData(customerEmail, fallbackAddress, buyerPhone);
    }

    if (paymentStatus === "PAID") {
      applyWebPayment(orderData, body.paymentMethod, paymentReference || code, body.paymentCard || {});
      queueWebInvoice(orderData);
    }

    try {
      const order = await models.orders.create(orderData);
      console.log(`🛒 [web-orders] Pedido web ${code} creado (${order._id})`);
      res.status(HttpStatusCode.Created).send({ id: String(order._id), status: "created" });
    } catch (error: any) {
      // Dos llamadas simultáneas con el mismo externalId: gana la primera.
      if (error?.code === 11000) {
        const dup = await models.orders.findOne({ "webOrder.externalId": externalId }, { _id: 1 }).lean();
        if (dup) {
          res.status(HttpStatusCode.Ok).send({ id: String(dup._id), status: "already_exists" });
          return;
        }
      }
      throw error;
    }
    return;
  } catch (error) {
    console.error("❌ [web-orders] Error creando pedido web:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error interno al crear el pedido web.",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

/**
 * PATCH /api/web-orders/:externalId/payment
 * La tienda avisa que verificó el pago (típicamente una transferencia).
 */
export async function updateWebOrderPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const externalId = String(req.params.externalId || "").trim();
    const { paymentStatus, paymentReference, paymentProofUrl } = req.body || {};
    // La tienda puede mandar solo el comprobante (sin tocar el pago) o "" / null para quitarlo si lo rechazó.
    const hasStatus = paymentStatus !== undefined && paymentStatus !== null;
    const hasProof = paymentProofUrl !== undefined;

    if (!hasStatus && !hasProof) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Envía paymentStatus o paymentProofUrl." });
      return;
    }
    if (hasStatus && paymentStatus !== "PAID" && paymentStatus !== "PENDING_VERIFICATION") {
      res.status(HttpStatusCode.BadRequest).send({ message: "paymentStatus debe ser 'PAID' o 'PENDING_VERIFICATION'." });
      return;
    }
    if (hasProof && paymentProofUrl !== null && paymentProofUrl !== "" && !isProofUrl(paymentProofUrl)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "paymentProofUrl debe ser una URL https." });
      return;
    }
    if (paymentReference !== undefined && paymentReference !== null && typeof paymentReference !== "string") {
      res.status(HttpStatusCode.BadRequest).send({ message: "paymentReference debe ser texto." });
      return;
    }

    const order = await models.orders.findOne({ "webOrder.externalId": externalId });
    if (!order || !order.webOrder) {
      res.status(HttpStatusCode.NotFound).send({ message: "No existe un pedido web con ese externalId." });
      return;
    }

    const now = new Date();
    order.updatedBy = WEB_ORDER_CHANNEL;

    if (hasProof) {
      const url = isProofUrl(paymentProofUrl) ? paymentProofUrl.trim() : undefined;
      if (url && url !== order.webOrder.paymentProofUrl) {
        order.webOrder.paymentProofUrl = url;
        order.webOrder.paymentProofAt = now;
        // Comprobante nuevo tras un rechazo desde la app interna: la ronda anterior queda cerrada.
        order.webOrder.proofRejected = undefined;
        order.auditLog.push({ user: WEB_ORDER_CHANNEL, action: PROOF_RECEIVED, at: now, details: `Por verificar · ${url}` });
      } else if (!url && order.webOrder.paymentProofUrl) {
        order.webOrder.paymentProofUrl = undefined;
        order.webOrder.paymentProofAt = undefined;
        order.auditLog.push({
          user: WEB_ORDER_CHANNEL,
          action: "Comprobante de transferencia rechazado desde la tienda online",
          at: now,
          details: "El cliente debe subir uno nuevo",
        });
      }
    }

    if (hasStatus) {
      const previousStatus = order.webOrder.paymentStatus;
      order.webOrder.paymentStatus = paymentStatus;
      const reference = optionalString(paymentReference);
      if (reference) order.webOrder.paymentReference = reference;
      const webMethod = order.webOrder.paymentMethod || "Transferencia";
      // Con cobros ya registrados en la app, paymentMethod refleja esos cobros: no se pisa.
      const hadPayments = (order.payments || []).length > 0;
      if (!hadPayments) order.paymentMethod = paymentMethodLabel(webMethod, paymentStatus);
      order.auditLog.push({
        user: WEB_ORDER_CHANNEL,
        action: paymentStatus === "PAID" ? "Pago verificado desde la tienda online" : "Pago marcado por verificar desde la tienda online",
        at: now,
        details: `Estado de pago: ${previousStatus || "—"} → ${paymentStatus}${reference ? ` · Ref. ${reference}` : ""}`,
      });
      if (paymentStatus === "PAID" && previousStatus !== "PAID") {
        const ref = order.webOrder.paymentReference || order.webOrder.code || externalId;
        if (applyWebPayment(order, webMethod, ref, req.body?.paymentCard || {})) {
          order.markModified("paymentDetails");
          order.markModified("payments");
        }
        queueWebInvoice(order);
      }
    }
    order.markModified("webOrder");
    await order.save();

    res.status(HttpStatusCode.Ok).send({ id: String(order._id) });
    return;
  } catch (error) {
    console.error("❌ [web-orders] Error actualizando pago:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error interno al actualizar el pago del pedido web.",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

/**
 * GET /api/web-orders/contifico-products?q=
 * Hasta 30 productos de la cuenta Nicole (catálogo cacheado) para que el admin de
 * la tienda vincule sus productos con Contífico.
 */
export async function searchContificoProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const q = normalizeString(String(req.query.q ?? ""));
    let catalog: any[];
    try {
      catalog = await nicoleContificoService.getCachedProducts();
    } catch (error: any) {
      console.error("❌ [web-orders] Contífico no respondió:", error?.message || error);
      res.status(HttpStatusCode.BadGateway).send({ message: "No se pudo consultar el catálogo de Contífico." });
      return;
    }

    const results = (Array.isArray(catalog) ? catalog : [])
      .filter((p) => p?.estado !== "I")
      .filter((p) => {
        if (!q) return true;
        return normalizeString(String(p?.nombre ?? "")).includes(q) || normalizeString(String(p?.codigo ?? "")).includes(q);
      })
      .slice(0, 30)
      .map((p) => ({ id: p.id, codigo: p.codigo, nombre: p.nombre, pvp1: p.pvp1 }));

    res.status(HttpStatusCode.Ok).send(results);
    return;
  } catch (error) {
    console.error("❌ [web-orders] Error buscando productos:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error interno al buscar productos de Contífico." });
    return;
  }
}

const MAX_STATUS_IDS = 100;

/** Fecha ISO o undefined: un dato raro en un pedido no debe tumbar la respuesta de todo el lote. */
function toIsoOrUndefined(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * GET /api/web-orders/status?externalIds=a,b,c
 * Solo lectura: la tienda consulta en qué va cada pedido para avisarle al cliente.
 * Proyección mínima (nada de datos del cliente; solo total, lo cobrado y si ya se facturó).
 * Los que no existen no vienen.
 */
export async function getWebOrderStatuses(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = Array.isArray(req.query.externalIds)
      ? req.query.externalIds.join(",")
      : String(req.query.externalIds ?? "");
    const externalIds = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];

    if (externalIds.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "externalIds es obligatorio (separados por coma)." });
      return;
    }
    if (externalIds.length > MAX_STATUS_IDS) {
      res.status(HttpStatusCode.BadRequest).send({ message: `Máximo ${MAX_STATUS_IDS} externalIds por consulta.` });
      return;
    }

    const orders: any[] = await models.orders
      .find(
        { "webOrder.externalId": { $in: externalIds } },
        {
          _id: 0,
          "webOrder.externalId": 1,
          "webOrder.paymentStatus": 1,
          "webOrder.paymentProofUrl": 1,
          "webOrder.proofRejected": 1,
          status: 1,
          deliveryDate: 1,
          deliveryTime: 1,
          invoiceStatus: 1,
          totalValue: 1,
          payments: 1,
          productionStage: 1,
          dispatchStatus: 1,
          voidedAt: 1,
          deliveryType: 1,
          branch: 1,
          updatedAt: 1,
        },
      )
      .lean();

    const results = orders.map((o) => ({
      externalId: o.webOrder?.externalId,
      ...(o.status ? { status: o.status } : {}),
      ...(o.productionStage ? { productionStage: o.productionStage } : {}),
      ...(o.dispatchStatus ? { dispatchStatus: o.dispatchStatus } : {}),
      ...(o.webOrder?.paymentStatus ? { paymentStatus: o.webOrder.paymentStatus } : {}),
      // voidedAt con valor pero ilegible sigue contando como anulado.
      ...(o.voidedAt ? { voidedAt: toIsoOrUndefined(o.voidedAt) ?? String(o.voidedAt) } : {}),
      deliveryType: o.deliveryType,
      ...(o.branch ? { branch: o.branch } : {}),
      // deliveryDate se guarda a la medianoche UTC del día de entrega: la parte de fecha del ISO es el día.
      ...(toIsoOrUndefined(o.deliveryDate) ? { deliveryDate: toIsoOrUndefined(o.deliveryDate)!.slice(0, 10) } : {}),
      ...(o.deliveryTime ? { deliveryTime: o.deliveryTime } : {}),
      invoiced: o.invoiceStatus === "PROCESSED",
      totalValue: Number(o.totalValue) || 0,
      paidAmount: Math.round(
        (o.payments || [])
          .filter((p: any) => (p?.status || "PAID") === "PAID")
          .reduce((sum: number, p: any) => sum + (Number(p?.monto) || 0), 0) * 100,
      ) / 100,
      updatedAt: toIsoOrUndefined(o.updatedAt),
      ...(o.webOrder?.paymentProofUrl ? { paymentProofUrl: o.webOrder.paymentProofUrl } : {}),
      // Comprobante rechazado en la app interna: la tienda borra el suyo y le pide otro al cliente.
      ...(o.webOrder?.proofRejected?.at
        ? {
            proofRejected: {
              ...(o.webOrder.proofRejected.reason ? { reason: o.webOrder.proofRejected.reason } : {}),
              at: toIsoOrUndefined(o.webOrder.proofRejected.at),
            },
          }
        : {}),
    }));

    res.status(HttpStatusCode.Ok).send(results);
    return;
  } catch (error) {
    console.error("❌ [web-orders] Error leyendo estados:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error interno al leer los estados de pedidos web." });
    return;
  }
}

/** Usuarios que reciben los avisos de la tienda: administradores de ventas de Nicole y superadmin. */
const NOTIFY_ROLES_BY_SOURCE = ["SALES_MANAGER"];
const NOTIFY_ROLES_ANY_SOURCE = ["superadmin"];

/**
 * GET /api/web-orders/notify-recipients
 * Correos a los que la tienda manda "pedido nuevo" y "comprobante recibido".
 * SALES_MANAGER de Nicole (contificoSource nicole/both o sin definir) y superadmin.
 * El modelo de usuario no tiene estado activo/inactivo: todo usuario existente cuenta.
 */
export async function getNotifyRecipients(req: Request, res: Response, next: NextFunction) {
  try {
    const users: any[] = await models.users
      .find(
        {
          $or: [
            {
              role: { $in: NOTIFY_ROLES_BY_SOURCE },
              $or: [
                { contificoSource: { $in: ["nicole", "both", null, ""] } },
                { contificoSource: { $exists: false } },
              ],
            },
            { role: { $in: NOTIFY_ROLES_ANY_SOURCE } },
          ],
        },
        { email: 1 },
      )
      .lean();

    const emails = [
      ...new Set(
        users
          .map((u) => String(u?.email ?? "").trim().toLowerCase())
          .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
      ),
    ].sort();

    res.status(HttpStatusCode.Ok).send({ emails });
    return;
  } catch (error) {
    console.error("❌ [web-orders] Error leyendo destinatarios de avisos:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error interno al leer los destinatarios de avisos." });
    return;
  }
}
