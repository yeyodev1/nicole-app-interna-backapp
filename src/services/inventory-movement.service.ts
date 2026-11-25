import { models } from "../models";
import { getEcuadorNow } from "../utils/date.utils";
import { normalizeString } from "../utils/string.utils";
import { RESTOCK_CHANNELS } from "../utils/future-sales.util";
import { buildContificoCategoryMaps, resolveProduct } from "../utils/contifico-categorias.util";
import { ContificoService } from "./contifico.service";
import {
  InventoryCompany,
  INVENTORY_COMPANIES,
  INVENTORY_BLOCK_TITLES,
  INVENTORY_MOVEMENT_START,
  WHOLE_CAKE_PORTIONS,
} from "../config/inventory.config";

/**
 * Movimiento de inventario (solo producto terminado). Solo lectura: no guarda nada.
 *
 * Pedido de Operaciones (Mauro, 23/11/2026). Cada toma de inventario cierra el periodo anterior:
 *   debería haber = toma de inicio + producción (tablet) − despachos (islas y pedidos)
 *   diferencia    = lo contado en la toma siguiente − debería haber
 *
 * Empieza con la toma del lunes 23/11/2026 (INVENTORY_MOVEMENT_START): las tomas anteriores no se
 * muestran ni se pueden pedir.
 *
 * Reglas:
 * - El periodo empieza cuando se cierra el bloque "Producto terminado" de su toma y termina cuando
 *   se cierra el de la toma siguiente (sin cierre: la hora en que se creó la toma). El periodo
 *   abierto llega hasta ahora.
 * - Entra: Ingreso de producción (`ProductionEntry`) de la empresa, por código.
 * - Sale: despachos registrados por Producción (`Order.dispatches`, por `reportedAt`), al salir de
 *   planta, sin esperar la recepción. "Restock" = reposición a islas; el resto = pedidos de
 *   clientes. "Restock-Bodega" no es producto terminado y no se cuenta.
 * - Cada línea despachada se identifica por el código de Contífico del producto del pedido
 *   (contifico_id → código) o, si no, por el nombre. Lo que no está en el catálogo de Producto
 *   terminado no se resta: se informa aparte. Las tortas enteras de WHOLE_CAKE_PORTIONS se restan
 *   como porciones de su sabor (10 por torta; Keto 8), porque la tablet y la toma llevan porciones.
 * - De la toma solo se usa lo contado en la unidad del producto en el catálogo.
 */

const EC_OFFSET_MS = 5 * 3600000;
const MAX_PERIODS = 26;
const MAX_UNMATCHED_NAMES = 8;

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });
const keyOf = (v: unknown) => normalizeString(String(v ?? "")).replace(/\s+/g, " ");
const ecDay = (d: Date) => new Date(d.getTime() - EC_OFFSET_MS).toISOString().slice(0, 10);
/** Medianoche de Ecuador de una fecha AAAA-MM-DD, como instante UTC. */
const ecMidnight = (day: string) => new Date(`${day}T05:00:00.000Z`);

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function companyOf(v: unknown): InventoryCompany {
  const c = String(v || "").toLowerCase() as InventoryCompany;
  if (!INVENTORY_COMPANIES.includes(c)) throw badRequest("Empresa no válida. Usa nicole o sucree.");
  return c;
}

/** Desde cuándo cuenta una toma: cierre del bloque Producto terminado o, si no se cerró, su creación. */
function cutoffOf(count: any): Date {
  const closed = count?.pt?.closedAt ? new Date(count.pt.closedAt) : null;
  if (closed && !isNaN(closed.getTime())) return closed;
  const created = count?.createdAt ? new Date(count.createdAt) : null;
  if (created && !isNaN(created.getTime())) return created;
  return ecMidnight(count.weekOf);
}

interface ProductRow {
  code: string;
  name: string;
  unit: string;
  category: string;
  inCatalog: boolean;
  start: number;
  counted: number | null;
  produced: number[];
  toIslands: number[];
  toOrders: number[];
}

export class InventoryMovementService {
  private contifico = {
    nicole: new ContificoService("nicole"),
    sucree: new ContificoService("sucree"),
  };

  /** Tomas de la empresa, de la más nueva a la más vieja, como periodos (toma → toma siguiente). */
  async getPeriods(companyRaw: unknown) {
    const company = companyOf(companyRaw);
    const counts = (await models.inventoryCounts
      .find({ company, weekOf: { $gte: INVENTORY_MOVEMENT_START } })
      .sort({ weekOf: -1 })
      .limit(MAX_PERIODS + 1)
      .select("weekOf responsible pt.status pt.closedAt createdAt")
      .lean()) as any[];
    const periods = counts.slice(0, MAX_PERIODS).map((c, i) => {
      const next = i > 0 ? counts[i - 1] : null;
      return {
        from: c.weekOf as string,
        to: next ? (next.weekOf as string) : null,
        open: !next,
        responsible: c.responsible || "",
        ptClosed: c.pt?.status === "closed",
      };
    });
    return { company, periods };
  }

  /** Movimiento del periodo que empieza con la toma `from` (AAAA-MM-DD). Sin `from`: el abierto. */
  async getMovement(companyRaw: unknown, fromRaw: unknown) {
    const company = companyOf(companyRaw);
    const fromIn = String(fromRaw || "").trim();
    if (fromIn && !/^\d{4}-\d{2}-\d{2}$/.test(fromIn)) throw badRequest("Fecha de la toma no válida.");
    if (fromIn && fromIn < INVENTORY_MOVEMENT_START) {
      throw badRequest(`El movimiento de inventario empieza con la toma del ${INVENTORY_MOVEMENT_START}.`);
    }

    const startCount: any = fromIn
      ? await models.inventoryCounts.findOne({ company, weekOf: fromIn }).lean()
      : await models.inventoryCounts
          .findOne({ company, weekOf: { $gte: INVENTORY_MOVEMENT_START } })
          .sort({ weekOf: -1 })
          .lean();
    if (!startCount) {
      if (fromIn) throw badRequest(`No hay toma de inventario del ${fromIn}.`);
      return { company, empty: true as const };
    }
    const endCount: any = await models.inventoryCounts
      .findOne({ company, weekOf: { $gt: startCount.weekOf } })
      .sort({ weekOf: 1 })
      .lean();

    const startAt = cutoffOf(startCount);
    const endAt = endCount ? cutoffOf(endCount) : new Date();
    const lastDay = endCount ? endCount.weekOf : ecDay(new Date());
    const days: string[] = [];
    for (let d = startCount.weekOf; d <= lastDay && days.length < 62; d = addDays(d, 1)) days.push(d);
    const dayIndex = (at: Date | string) => {
      const day = typeof at === "string" ? at : ecDay(at);
      const i = days.indexOf(day);
      if (i >= 0) return i;
      return day < days[0] ? 0 : days.length - 1;
    };

    // Catálogo vigente de producto terminado.
    const catalog: any = await models.inventoryCatalogs.findOne({ company }).lean();
    const ptBlock = (catalog?.blocks || []).find((b: any) => b.key === "pt");
    const rows = new Map<string, ProductRow>();
    const byName = new Map<string, string>();
    const newRow = (code: string, name: string, unit: string, category: string, inCatalog: boolean): ProductRow => ({
      code, name, unit, category, inCatalog,
      start: 0,
      counted: endCount ? 0 : null,
      produced: days.map(() => 0),
      toIslands: days.map(() => 0),
      toOrders: days.map(() => 0),
    });
    for (const cat of ptBlock?.categories || []) {
      for (const p of cat.products || []) {
        const k = keyOf(p.code);
        if (!k || rows.has(k)) continue;
        rows.set(k, newRow(p.code, p.name, p.unit, cat.name, true));
        byName.set(keyOf(p.name), k);
      }
    }
    const rowFor = (code: string, name: string, category: string, unit = ""): ProductRow => {
      const k = keyOf(code);
      if (!rows.has(k)) rows.set(k, newRow(code, name, unit, category, false));
      return rows.get(k)!;
    };
    const OUTSIDE = "Fuera del catálogo";

    // Tomas: solo lo contado en la unidad del catálogo.
    const addCount = (count: any, field: "start" | "counted") => {
      for (const it of count?.pt?.items || []) {
        const r = rows.get(keyOf(it.code));
        if (r && keyOf(it.unit) !== keyOf(r.unit)) continue;
        const row = r || rowFor(it.code, it.name, OUTSIDE, it.unit);
        row[field] = (row[field] || 0) + (Number(it.quantity) || 0);
      }
    };
    addCount(startCount, "start");
    if (endCount) addCount(endCount, "counted");

    // Entradas: Ingreso de producción.
    const entries = (await models.productionEntries
      .find({ company, createdAt: { $gt: startAt, $lte: endAt } })
      .select("date items createdAt")
      .lean()) as any[];
    for (const e of entries) {
      const i = dayIndex(e.date || new Date(e.createdAt));
      for (const it of e.items || []) {
        const row = rows.get(keyOf(it.code)) || rowFor(it.code, it.name, OUTSIDE);
        row.produced[i] += Number(it.quantity) || 0;
      }
    }

    // Salidas: despachos de Producción (reposición a islas y pedidos).
    const sourceFilter = company === "sucree" ? { contificoSource: "sucree" } : { contificoSource: { $ne: "sucree" } };
    const orders = (await models.orders
      .find({
        ...sourceFilter,
        salesChannel: { $ne: RESTOCK_CHANNELS[1] },
        dispatches: { $elemMatch: { reportedAt: { $gt: startAt, $lte: endAt } } },
      })
      .select("salesChannel products._id products.name products.contifico_id dispatches.reportedAt dispatches.items")
      .lean()) as any[];

    const maps = await buildContificoCategoryMaps(this.contifico[company]);
    const unmatched = { lines: 0, units: 0, names: [] as string[] };
    const wholeCakes = { cakes: 0, portions: 0 };
    for (const o of orders) {
      const toIslands = o.salesChannel === RESTOCK_CHANNELS[0];
      const productsById = new Map((o.products || []).map((p: any) => [String(p._id), p]));
      for (const d of o.dispatches || []) {
        const at = d.reportedAt ? new Date(d.reportedAt) : null;
        if (!at || at <= startAt || at > endAt) continue;
        const i = dayIndex(at);
        for (const it of d.items || []) {
          const qty = Number(it.quantitySent) || 0;
          if (qty <= 0) continue;
          const p: any = productsById.get(String(it.productId));
          const name = String(p?.name || it.name || "");
          const codigo = resolveProduct(maps, name, p?.contifico_id).codigo;
          let k = (codigo && rows.has(keyOf(codigo)) ? keyOf(codigo) : null) || byName.get(keyOf(name)) || null;
          let units = qty;
          // Torta entera: se resta como porciones de su sabor (si esa porción está en el catálogo).
          const cake = !k && codigo ? WHOLE_CAKE_PORTIONS[company][String(codigo).toUpperCase()] : undefined;
          if (cake && rows.get(keyOf(cake.portion))?.inCatalog) {
            k = keyOf(cake.portion);
            units = qty * cake.portions;
            wholeCakes.cakes += qty;
            wholeCakes.portions += units;
          }
          const row = k ? rows.get(k) : null;
          if (!row || !row.inCatalog) {
            if (/delivery|env[ií]o/i.test(name)) continue;
            unmatched.lines += 1;
            unmatched.units += qty;
            if (name && unmatched.names.length < MAX_UNMATCHED_NAMES && !unmatched.names.includes(name)) unmatched.names.push(name);
            continue;
          }
          (toIslands ? row.toIslands : row.toOrders)[i] += units;
        }
      }
    }

    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const products = Array.from(rows.values()).filter(
      (r) => r.start || r.counted || sum(r.produced) || sum(r.toIslands) || sum(r.toOrders)
    );
    const categoryOrder = [
      ...(ptBlock?.categories || []).map((c: any) => c.name as string),
      OUTSIDE,
    ];
    // Códigos de torta entera que restan de cada porción (para mostrarlos bajo el nombre).
    const cakeCodesOf = new Map<string, string[]>();
    for (const [cakeCode, c] of Object.entries(WHOLE_CAKE_PORTIONS[company])) {
      const pk = keyOf(c.portion);
      cakeCodesOf.set(pk, [...(cakeCodesOf.get(pk) || []), cakeCode]);
    }
    const categories = categoryOrder
      .map((name) => ({ name, products: products.filter((p) => p.category === name) }))
      .filter((c) => c.products.length)
      .map((c) => ({
        name: c.name,
        products: c.products.map((p) => ({
          code: p.code,
          name: p.name,
          unit: p.unit,
          inCatalog: p.inCatalog,
          wholeCakeCodes: cakeCodesOf.get(keyOf(p.code)) || [],
          start: round(p.start),
          counted: p.counted === null ? null : round(p.counted),
          produced: p.produced.map(round),
          toIslands: p.toIslands.map(round),
          toOrders: p.toOrders.map(round),
        })),
      }));

    return {
      company,
      empty: false as const,
      block: INVENTORY_BLOCK_TITLES.pt,
      open: !endCount,
      from: startCount.weekOf as string,
      to: endCount ? (endCount.weekOf as string) : null,
      startAt,
      endAt: endCount ? endAt : null,
      responsibleFrom: startCount.responsible || "",
      responsibleTo: endCount?.responsible || "",
      startClosed: startCount.pt?.status === "closed",
      endClosed: endCount ? endCount.pt?.status === "closed" : null,
      days,
      today: getEcuadorNow().toISOString().slice(0, 10),
      categories,
      unmatched,
      wholeCakes,
    };
  }
}

const round = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export const inventoryMovementService = new InventoryMovementService();
