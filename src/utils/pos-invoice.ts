/**
 * Pedidos que factura el punto de venta, no la app.
 *
 * Regla de Operaciones (Mauro, 17/11/2026): un pedido de hoy para hoy que sale
 * del punto de venta NO se factura desde la app. Se registra en la app (cuenta
 * para la comisión del asesor) y lo factura la caja de la isla, para que el
 * producto se descuente del inventario de ese punto de venta.
 *
 * Antes la regla solo se aplicaba en la venta con link pagada "en isla"
 * (f9cf591). Con transferencia o tarjeta, con Consumidor Final automático, al
 * registrar un cobro o en el cron nocturno, la app facturaba igual y la caja
 * volvía a facturar: 19 dobles facturas entre el 01 y el 17/11/2026.
 *
 * El pedido queda marcado con `posInvoiceBranch` (la isla que factura). Todos los
 * caminos que emiten factura revisan `appMayInvoice()` antes de llamar a Contífico.
 */

export const CDP_BRANCH_NAME = "Centro de Producción";

/** Isla que factura un delivery de hoy para hoy cuando el pedido no dice de cuál sale. */
export const DEFAULT_POS_BRANCH: Record<"nicole" | "sucree", string> = {
  nicole: "San Marino",
  sucree: "Entre Ríos",
};

const isCdp = (branch: unknown) => /centro|producc/i.test(String(branch || ""));

export function todayInEcuador(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Guayaquil" });
}

/** "YYYY-MM-DD" de un deliveryDate (medianoche UTC) o de un string ya en ese formato. */
function ymdOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value as any);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** El pedido lo factura el punto de venta: la app no debe emitir factura. */
export function isPosInvoice(order: any): boolean {
  return !!String(order?.posInvoiceBranch || "").trim();
}

/** La app puede emitir la factura de este pedido. */
export function appMayInvoice(order: any): boolean {
  return !isPosInvoice(order);
}

export function posInvoiceMessage(order: any): string {
  return `La factura de este pedido la emite el punto de venta (${order?.posInvoiceBranch}). La app no la emite para no duplicarla.`;
}

/** Filtro Mongo: pedidos que la app sí puede facturar. */
export const APP_INVOICES_FILTER = { posInvoiceBranch: { $in: [null, ""] } };

/**
 * Isla que factura el pedido, o null si lo factura la app.
 *  - Pedidos web (tienda) y reposiciones: siempre null (fuera de esta regla).
 *  - Venta con link: entrega hoy → retiro: la isla elegida; delivery: la isla de
 *    salida, o la de la marca por defecto (el link guarda "Centro de Producción").
 *  - Pedido manual con "No enviar a producción": sale del local (exitPoint).
 */
export function resolvePosInvoiceBranch(order: any, deliveryYmd?: string | null): string | null {
  if (!order) return null;
  if (order.webOrder?.externalId) return null;
  if (/^restock/i.test(String(order.salesChannel || ""))) return null;

  const source: "nicole" | "sucree" = order.contificoSource === "sucree" ? "sucree" : "nicole";

  if (order.clientLink) {
    const ymd = deliveryYmd ?? ymdOf(order.deliveryDate);
    if (!ymd || ymd !== todayInEcuador()) return null;
    if (order.deliveryType === "retiro") {
      return order.branch && !isCdp(order.branch) ? String(order.branch) : null;
    }
    return order.branch && !isCdp(order.branch) ? String(order.branch) : DEFAULT_POS_BRANCH[source];
  }

  if (order.skipProduction === true) {
    const exit = String(order.exitPoint || order.branch || "").trim();
    return exit && !isCdp(exit) ? exit : null;
  }

  return null;
}
