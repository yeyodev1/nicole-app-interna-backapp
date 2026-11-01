import { Types } from "mongoose";
import { models } from "../models";
import CustomError from "../errors/customError.error";

/**
 * Cupo de deliveries por hora (decisión de Nicole, 30/10/2026): máximo 8 entregas a
 * domicilio en la misma hora; al llenarse, esa hora deja de ofrecerse para delivery.
 * El retiro no tiene límite.
 *
 * Esta app es la fuente de la verdad porque aquí caen todos los canales: pedido manual,
 * venta con link y pedidos de la tienda online. La tienda consulta el cupo con
 * `GET /api/web-orders/delivery-slots?date=` antes de crear un pedido.
 */
export const DELIVERY_SLOT_CAPACITY = 8;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "14:30" → "14:00": el cupo es por hora. */
export function hourOf(time: string | undefined | null): string | null {
  const m = /^([01]?\d|2[0-3]):[0-5]\d$/.exec(String(time ?? "").trim());
  return m ? `${m[1]!.padStart(2, "0")}:00` : null;
}

/** Deliveries vigentes por hora de un día ("YYYY-MM-DD", deliveryDate se guarda como medianoche UTC). */
export async function deliveryCountsByHour(date: string, excludeOrderId?: string): Promise<Record<string, number>> {
  if (!YMD.test(date)) throw new CustomError("Fecha inválida (YYYY-MM-DD).", 400);
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d!));
  const end = new Date(Date.UTC(y!, m! - 1, d!, 23, 59, 59, 999));

  const query: any = {
    deliveryType: "delivery",
    deliveryDate: { $gte: start, $lte: end },
    voidedAt: null,
    productionStage: { $ne: "VOID" },
    dispatchStatus: { $ne: "RETURNED" },
  };
  if (excludeOrderId && Types.ObjectId.isValid(excludeOrderId)) {
    query._id = { $ne: new Types.ObjectId(excludeOrderId) };
  }

  const orders = await models.orders.find(query).select("deliveryTime").lean();
  const counts: Record<string, number> = {};
  for (const o of orders as any[]) {
    const hour = hourOf(o.deliveryTime);
    if (hour) counts[hour] = (counts[hour] || 0) + 1;
  }
  return counts;
}

/** Cupo del día: cuántos hay por hora y qué horas ya no aceptan delivery. */
export async function deliverySlotsFor(date: string) {
  const counts = await deliveryCountsByHour(date);
  const full = Object.keys(counts)
    .filter((h) => counts[h]! >= DELIVERY_SLOT_CAPACITY)
    .sort();
  return { date, capacity: DELIVERY_SLOT_CAPACITY, counts, full };
}

/** Lanza 409 si esa hora ya tiene el cupo de deliveries lleno. */
export async function assertDeliverySlotAvailable(
  date: string,
  time: string | undefined | null,
  excludeOrderId?: string,
): Promise<void> {
  const hour = hourOf(time);
  if (!hour || !YMD.test(date)) return;
  const counts = await deliveryCountsByHour(date, excludeOrderId);
  if ((counts[hour] || 0) >= DELIVERY_SLOT_CAPACITY) {
    throw new CustomError(
      `Las ${hour.replace(":", "h")} ya tienen ${DELIVERY_SLOT_CAPACITY} deliveries. Elige otra hora para la entrega a domicilio.`,
      409,
    );
  }
}

/** "YYYY-MM-DD" de un deliveryDate (Date a medianoche UTC o string ISO). */
export function ymdOf(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
