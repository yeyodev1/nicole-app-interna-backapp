/**
 * Reservas sin pago de la tienda online (`webOrder.paymentMethod: "Reserva"`).
 *
 * Viven en la colección de pedidos, por eso el seguimiento no agrega valores a `status`:
 * varias rutinas (facturación, tienda) dependen de `PENDIENTE_GESTION`.
 * - Nueva / Contactada: `status: PENDIENTE_GESTION`, se distinguen por `webOrder.contactLog`.
 * - Gestionada: `status: GESTIONADO`. Es la única que cuenta como venta.
 * - Descartada: `webOrder.discard` + anulada (`VOID`), así sale de producción, cupos y facturación.
 */

export const RESERVA_METHOD = "Reserva";
export const STATUS_PENDING = "PENDIENTE_GESTION";

/** Para listas operativas que no excluyen por sí solas los pedidos anulados. */
export const NOT_DISCARDED = { "webOrder.discard.at": null };

/**
 * Para reportes de ventas: una reserva sin gestionar todavía no es venta.
 * Solo excluye ese estado: una reserva ya gestionada o entregada sigue contando.
 */
export const NOT_UNCONFIRMED_RESERVA = {
  $nor: [{ "webOrder.paymentMethod": RESERVA_METHOD, status: STATUS_PENDING }],
};

export function isReservaOrder(order: any): boolean {
  return order?.webOrder?.paymentMethod === RESERVA_METHOD;
}

export function isDiscarded(order: any): boolean {
  return !!order?.webOrder?.discard?.at;
}

/** Hay un cobro registrado (también vale un abono). */
export function hasPayment(order: any): boolean {
  return (
    (order?.payments || []).length > 0 ||
    order?.webOrder?.paymentStatus === "PAID" ||
    order?.settledInIsland === true
  );
}

/** Saca la reserva de Descartadas y le devuelve la etapa de producción que tenía. Muta el documento. */
export function restoreFromDiscard(order: any, user: string, details: string): void {
  const previousStage = order.webOrder?.discard?.previousStage || "PENDING";
  order.webOrder.discard = undefined;
  order.voidedAt = null;
  order.productionStage = previousStage;
  order.updatedBy = user;
  order.markModified("webOrder");
  order.auditLog.push({ user, action: "Reserva recuperada", at: new Date(), details });
}

/**
 * Reportes de ventas (Ventas & Comisiones y dashboard general): solo cuenta lo que tiene un
 * cobro registrado (un abono basta; también el cobro en isla o la tienda pagada), y nunca un
 * pedido anulado ni una reserva descartada. Va en `$and` para no chocar con otros `$or`.
 */
export const COUNTS_AS_SALE = {
  $and: [
    { voidedAt: null, productionStage: { $ne: "VOID" }, "webOrder.discard.at": null },
    {
      $or: [
        { "payments.0": { $exists: true } },
        { "webOrder.paymentStatus": "PAID" },
        { settledInIsland: true },
      ],
    },
  ],
};
