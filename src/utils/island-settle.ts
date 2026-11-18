/**
 * Liquidar un pedido en la isla sin duplicar pagos ni facturas.
 *
 * Antes, al recibir en la isla (Recepción Masiva) o con "Facturar en isla", se
 * sumaba SIEMPRE un pago ISLA por el total del pedido, aunque ya estuviera
 * pagado por transferencia o ya lo hubiera facturado la app. Resultado: pagos
 * registrados dos veces y pedidos marcados "facturado en isla" que ya tenían
 * factura de la app (la cajera los volvía a facturar).
 *
 * Reglas:
 *  - Ya facturado por la app → no se marca "en isla" ni se suma pago. La caja
 *    no debe facturarlo.
 *  - Ya pagado completo → se marca "en isla" (la caja factura) sin sumar pago.
 *  - Con saldo → se suma un pago ISLA solo por el saldo pendiente.
 */

const TOLERANCE = 0.05;

/** La app ya emitió la factura de este pedido en Contífico. */
export function isAppInvoiced(order: any): boolean {
  return order?.invoiceStatus === "PROCESSED" || !!order?.invoiceInfo?.id;
}

export function appInvoiceNumber(order: any): string {
  return String(order?.invoiceInfo?.documento || order?.invoiceInfo?.numero || "").trim();
}

export function alreadyInvoicedMessage(order: any): string {
  const num = appInvoiceNumber(order);
  return `Este pedido ya fue facturado por la app${num ? ` (factura ${num})` : ""}. No lo factures en caja.`;
}

/** Suma de los pagos registrados (menos los que quedaron en ERROR). */
export function paidAmount(order: any): number {
  return (order?.payments || [])
    .filter((p: any) => String(p?.status || "").toUpperCase() !== "ERROR")
    .reduce((sum: number, p: any) => sum + (Number(p?.monto) || 0), 0);
}

export function pendingBalance(order: any): number {
  const total = Number(order?.totalValue) || 0;
  return Math.max(0, Math.round((total - paidAmount(order)) * 100) / 100);
}

export type IslandSettleResult = "ALREADY_INVOICED" | "SETTLED_NO_PAYMENT" | "SETTLED_WITH_PAYMENT";

/**
 * Aplica la liquidación en isla sobre el documento (no guarda).
 * Devuelve qué se hizo para que el llamador responda o registre.
 */
export function applyIslandSettle(order: any, islandName: string, reference: string): IslandSettleResult {
  if (isAppInvoiced(order)) return "ALREADY_INVOICED";

  order.settledInIsland = true;
  order.settledIslandName = islandName;

  const balance = pendingBalance(order);
  if (balance <= TOLERANCE) return "SETTLED_NO_PAYMENT";

  order.payments.push({
    forma_cobro: "ISLA",
    monto: balance,
    fecha: new Date(),
    reference,
    status: "PAID",
  });
  order.paymentMethod = `Isla: ${islandName}`;

  if (!order.paymentDetails?.monto) {
    order.paymentDetails = {
      forma_cobro: "ISLA",
      monto: balance,
      fecha: new Date().toISOString().split("T")[0],
      numero_comprobante: `ISLA-${islandName}`,
    };
  }
  return "SETTLED_WITH_PAYMENT";
}
