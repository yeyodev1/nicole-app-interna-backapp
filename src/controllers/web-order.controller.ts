import { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { models } from "../models";
import { ContificoService } from "../services/contifico.service";
import { isPrecioIvaIncluido } from "../config/precio-final.config";
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

function paymentMethodLabel(method: string, status: WebPaymentStatus): string {
  if (method === "Payphone") return "Payphone (pagado)";
  return status === "PAID" ? "Transferencia (verificada)" : "Transferencia (por verificar)";
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
      products.push({ name: "Delivery", quantity: 1, price: deliveryValue });
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

    const commentLines = [
      `Pedido web ${code}`,
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

    const orderData: any = {
      orderDate: now,
      deliveryDate,
      deliveryTime: body.deliveryTime,
      customerName: String(body.customerName).trim(),
      customerPhone: String(body.customerPhone).trim(),
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
      ],
      webOrder: {
        externalId,
        code,
        customerEmail,
        customerIdNumber,
        paymentMethod: body.paymentMethod,
        paymentStatus,
        paymentReference,
        deliveryReference,
        ...(deliveryKm !== undefined ? { deliveryKm } : {}),
        ...(originBranch ? { originBranch } : {}),
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
      orderData.invoiceData = {
        ruc: String(inv.ruc ?? "").trim(),
        businessName: String(inv.businessName ?? "").trim(),
        email: String(inv.email ?? "").trim(),
        address: String(inv.address ?? "").trim(),
        ...(inv.personType ? { personType: inv.personType } : {}),
      };
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
    const { paymentStatus, paymentReference } = req.body || {};

    if (paymentStatus !== "PAID" && paymentStatus !== "PENDING_VERIFICATION") {
      res.status(HttpStatusCode.BadRequest).send({ message: "paymentStatus debe ser 'PAID' o 'PENDING_VERIFICATION'." });
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

    const previousStatus = order.webOrder.paymentStatus;
    order.webOrder.paymentStatus = paymentStatus;
    const reference = optionalString(paymentReference);
    if (reference) order.webOrder.paymentReference = reference;
    order.paymentMethod = paymentMethodLabel(order.webOrder.paymentMethod || "Transferencia", paymentStatus);
    order.updatedBy = WEB_ORDER_CHANNEL;
    order.auditLog.push({
      user: WEB_ORDER_CHANNEL,
      action: paymentStatus === "PAID" ? "Pago verificado desde la tienda online" : "Pago marcado por verificar desde la tienda online",
      at: new Date(),
      details: `Estado de pago: ${previousStatus || "—"} → ${paymentStatus}${reference ? ` · Ref. ${reference}` : ""}`,
    });
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
