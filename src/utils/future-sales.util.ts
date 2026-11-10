/**
 * Ventas a futuro (Orden 7): cálculo puro, sin base de datos, para poder probarlo.
 * Entra: pedidos ya filtrados (clientes, sin reposiciones, sin enviar) y la ventana de 10 días.
 * Sale: por producto y por día, lo PENDIENTE DE ENVIAR (pedido − ya despachado).
 */
export interface FutureSalesDay {
  date: string; // AAAA-MM-DD (fecha de entrega)
  units: number;
  orders: number;
  delivery: number;
  pickup: number;
  percentOfMax: number; // 100 = día más comprometido de la ventana
  level: "LIBRE" | "BAJO" | "MEDIO" | "ALTO" | "MAS_COMPROMETIDO";
}
export interface FutureSalesProduct {
  name: string;
  total: number;
  perDay: Record<string, number>;
}
export interface FutureSalesResult {
  from: string;
  to: string;
  days: FutureSalesDay[];
  products: FutureSalesProduct[];
  totals: { units: number; orders: number; delivery: number; pickup: number };
  maxDay: string | null;
  unpaid: { date: string; customer: string; pending: number }[];
}


export const RESTOCK_CHANNELS = ["Restock", "Restock-Bodega"];


const normKey = (s: string) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();


const money = (n: number) => Math.round(n * 100) / 100;


export function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}


/** deliveryDate se guarda a las 00:00 UTC del día de entrega. */
export const deliveryDayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10);


/** Orden 8: llave y nombre del producto (por defecto, el nombre normalizado). */
export type ProductKeyOf = (product: any, order: any) => { key: string; name: string };
const byName: ProductKeyOf = (p) => ({ key: normKey(p.name), name: String(p.name).trim() });

export function buildFutureSales(orders: any[], from: string, productOf: ProductKeyOf = byName): FutureSalesResult {
  const to = addDaysStr(from, 9);
  const days: string[] = Array.from({ length: 10 }, (_, i) => addDaysStr(from, i));
  const dayUnits: Record<string, number> = {};
  const dayOrders: Record<string, { delivery: number; pickup: number }> = {};
  const products = new Map<string, FutureSalesProduct>();
  const unpaid: FutureSalesResult["unpaid"] = [];


  for (const order of orders) {
    if (!order?.deliveryDate) continue;
    const date = deliveryDayOf(order.deliveryDate);
    if (date < from || date > to) continue;
    if (RESTOCK_CHANNELS.includes(order.salesChannel)) continue; // defensa extra


    // Lo ya despachado por producto (por productId; si falta, por nombre)
    const sentById = new Map<string, number>();
    const sentByName = new Map<string, number>();
    for (const d of order.dispatches || []) {
      for (const it of d.items || []) {
        const q = Number(it.quantitySent) || 0;
        if (it.productId) sentById.set(String(it.productId), (sentById.get(String(it.productId)) || 0) + q);
        else sentByName.set(normKey(it.name), (sentByName.get(normKey(it.name)) || 0) + q);
      }
    }


    let orderPending = 0;
    for (const p of order.products || []) {
      const sent = (p._id ? sentById.get(String(p._id)) : undefined) ?? sentByName.get(normKey(p.name)) ?? 0;
      const pending = Math.max(0, (Number(p.quantity) || 0) - sent); // cortesías incluidas: igual se producen
      if (pending <= 0) continue;
      orderPending += pending;
      const { key: k, name } = productOf(p, order);
      let row = products.get(k);
      if (!row) { row = { name, total: 0, perDay: {} }; products.set(k, row); }
      row.total += pending;
      row.perDay[date] = (row.perDay[date] || 0) + pending;
      dayUnits[date] = (dayUnits[date] || 0) + pending;
    }
    if (orderPending <= 0) continue; // pedido ya enviado completo: no cuenta


    const slot = (dayOrders[date] ||= { delivery: 0, pickup: 0 });
    if (order.deliveryType === "delivery") slot.delivery++; else slot.pickup++;


    const paid = money((order.payments || []).reduce((s: number, x: any) => s + (Number(x.monto) || 0), 0));
    const pendingMoney = money(Math.max(0, (order.totalValue || 0) - paid));
    if (pendingMoney > 0.05) unpaid.push({ date, customer: order.customerName || "", pending: pendingMoney });
  }


  const max = Math.max(0, ...days.map((d) => dayUnits[d] || 0));
  const outDays: FutureSalesDay[] = days.map((date) => {
    const units = dayUnits[date] || 0;
    const o = dayOrders[date] || { delivery: 0, pickup: 0 };
    const pct = max > 0 ? Math.round((100 * units) / max) : 0;
    const level: FutureSalesDay["level"] =
      units === 0 ? "LIBRE" : units === max ? "MAS_COMPROMETIDO" : pct >= 70 ? "ALTO" : pct >= 40 ? "MEDIO" : "BAJO";
    return { date, units, orders: o.delivery + o.pickup, delivery: o.delivery, pickup: o.pickup, percentOfMax: pct, level };
  });


  const productList = Array.from(products.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "es"));
  const totals = outDays.reduce(
    (t, d) => ({ units: t.units + d.units, orders: t.orders + d.orders, delivery: t.delivery + d.delivery, pickup: t.pickup + d.pickup }),
    { units: 0, orders: 0, delivery: 0, pickup: 0 }
  );
  const maxDay = max > 0 ? outDays.find((d) => d.units === max)!.date : null;
  unpaid.sort((a, b) => a.date.localeCompare(b.date));
  return { from, to, days: outDays, products: productList, totals, maxDay, unpaid };
}
