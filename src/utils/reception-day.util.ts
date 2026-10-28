const RESTOCK_CHANNELS = ["Restock", "Restock-Bodega"];
const DAY_MS = 24 * 3600000;
const EC_OFFSET_MS = 5 * 3600000; // Ecuador = UTC-5

const toDateStr = (d: Date) => d.toISOString().split("T")[0];

/**
 * Día (YYYY-MM-DD) del cierre en el que cuenta lo que llegó en un despacho.
 *
 * Reposición (Restock/Restock-Bodega): lo pide el cierre del día X
 * (`orderDate` = X) y cuenta como RECIBIDO en el cierre siguiente (X + 1),
 * sin importar la hora real del despacho. Así el cuadre sale bien aunque el
 * despacho se registre a deshoras o el cierre se haga con otra fecha
 * (selector de día de las pruebas).
 * Resto de pedidos: el día Ecuador de la marca de tiempo (`at`).
 */
export function receptionDayOf(
  order: { salesChannel?: string; orderDate?: Date | string | null },
  at: Date | string
): string {
  if (order.salesChannel && RESTOCK_CHANNELS.includes(order.salesChannel) && order.orderDate) {
    return toDateStr(new Date(new Date(order.orderDate).getTime() + DAY_MS));
  }
  return toDateStr(new Date(new Date(at).getTime() - EC_OFFSET_MS));
}

/**
 * Filtro Mongo de los pedidos cuyos despachos pueden contar entre `fromStr` y
 * `toStr` (inclusive). Es amplio a propósito: el día exacto se decide después
 * con `receptionDayOf`.
 */
export function receptionCandidatesQuery(fromStr: string, toStr: string) {
  const start = new Date(`${fromStr}T00:00:00.000Z`);
  const end = new Date(new Date(`${toStr}T00:00:00.000Z`).getTime() + DAY_MS + EC_OFFSET_MS);
  return {
    $or: [
      { "dispatches.receivedAt": { $gte: start, $lte: end } },
      { "dispatches.reportedAt": { $gte: start, $lte: end } },
      {
        salesChannel: { $in: RESTOCK_CHANNELS },
        orderDate: { $gte: new Date(start.getTime() - DAY_MS), $lt: new Date(end.getTime() - DAY_MS - EC_OFFSET_MS) },
      },
    ],
  };
}
