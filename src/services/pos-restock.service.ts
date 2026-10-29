import mongoose from "mongoose";
import { models } from "../models";
import { getEcuadorNow } from "../utils/date.utils";
import { IPOSStockObjective, WeeklyObjectives } from "../models/pos-stock-objective.model";
import { IPOSDailyEntry } from "../models/pos-daily-entry.model";
import { ContificoService } from "./contifico.service";
import { getBranchPuntoCodes } from "../config/contifico-pos.config";
import { normalizeString } from "../utils/string.utils";
import { buildContificoCategoryMaps } from "../utils/contifico-categorias.util";
import { receptionDayOf, receptionCandidatesQuery } from "../utils/reception-day.util";

// Day-of-week index (getUTCDay) → objectives key
const DOW_KEYS: (keyof WeeklyObjectives)[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Case-insensitive branch matcher to tolerate name inconsistencies in the DB
// e.g. "Mall del sol" === "Mall del Sol"
function branchMatch(branch: string): RegExp {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`, "i");
}

function getObjectiveForDow(objectives: WeeklyObjectives, dowIndex: number): number {
  return objectives[DOW_KEYS[dowIndex]] ?? 0;
}

function parseDateStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

interface PosSalesAgg {
  byProductId: Map<string, number>;
  byProductName: Map<string, number>;
}

export class POSRestockService {
  private contifico = new ContificoService("nicole");
  // Cache corto por fecha, compartido entre sucursales: Contífico tarda ~10-15s
  // en devolver el día completo y el formulario se recarga varias veces.
  private docsCache = new Map<string, { at: number; byPos: Map<string, PosSalesAgg> }>();
  private static readonly SALES_CACHE_TTL = 3 * 60 * 1000;

  // Los puntos de emisión casi nunca cambian: 1h de caché en memoria
  private puntosCache: { at: number; data: any[] } | null = null;

  private async getPuntosEmisionCached(): Promise<any[]> {
    if (this.puntosCache && Date.now() - this.puntosCache.at < 3600 * 1000) {
      return this.puntosCache.data;
    }
    const data = await this.contifico.getPuntosEmision();
    if (Array.isArray(data) && data.length > 0) {
      this.puntosCache = { at: Date.now(), data };
    }
    return data;
  }

  /**
   * Facturas del día en Contífico agregadas por punto de emisión:
   * pos → cantidades vendidas por producto (id y nombre normalizado).
   * El filtro `pos` de la API se ignora server-side, así que se baja el día
   * completo una vez y se cachea.
   *
   * Doble caché: memoria (la instancia) y Mongo (compartida entre instancias
   * serverless). Sin la de Mongo, cada instancia nueva de Vercel pagaba los
   * ~15s de Contífico y la pantalla se sentía lenta o daba timeout.
   */
  private async getDaySalesByPos(dateStr: string): Promise<Map<string, PosSalesAgg>> {
    const cached = this.docsCache.get(dateStr);
    if (cached && Date.now() - cached.at < POSRestockService.SALES_CACHE_TTL) {
      return cached.byPos;
    }

    // Hoy cambia cada rato (5 min); un día pasado casi no cambia (6 h).
    const ecTodayStr = getEcuadorNow().toISOString().split("T")[0];
    const mongoTtl = dateStr === ecTodayStr ? 5 * 60 * 1000 : 6 * 3600 * 1000;
    const cacheCol = mongoose.connection.collection("contifico_sales_cache");

    try {
      const doc = await cacheCol.findOne({ date: dateStr });
      if (doc && doc.fetchedAt && Date.now() - new Date(doc.fetchedAt).getTime() < mongoTtl) {
        const byPos = this.deserializeByPos(doc.byPos);
        this.docsCache.set(dateStr, { at: Date.now(), byPos });
        return byPos;
      }
    } catch (err: any) {
      console.warn(`⚠️ [POS] Caché Mongo de ventas ilegible (${dateStr}): ${err?.message || err}`);
    }

    const [y, m, d] = dateStr.split("-");
    const fecha = `${d}/${m}/${y}`; // DD/MM/YYYY

    const byPos = new Map<string, PosSalesAgg>();
    const seenIds = new Set<string>();
    const PAGE_SIZE = 500;
    const MAX_PAGES = 10;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.contifico.getDocuments({
        fecha_emision: fecha,
        tipo_registro: "CLI",
        result_size: PAGE_SIZE,
        result_page: page,
      });
      const docs = Array.isArray(res) ? res : [];

      let nuevos = 0;
      for (const doc of docs) {
        const id = String(doc?.id || "");
        if (id && seenIds.has(id)) continue; // la API repitió resultados
        if (id) seenIds.add(id);
        nuevos++;

        if (doc.anulado || doc.tipo_documento !== "FAC" || !doc.pos) continue;

        let agg = byPos.get(doc.pos);
        if (!agg) {
          agg = { byProductId: new Map(), byProductName: new Map() };
          byPos.set(doc.pos, agg);
        }
        for (const det of doc.detalles || []) {
          const qty = parseFloat(det.cantidad || "0");
          if (!qty) continue;
          if (det.producto_id) {
            agg.byProductId.set(det.producto_id, (agg.byProductId.get(det.producto_id) || 0) + qty);
          }
          if (det.producto_nombre) {
            const key = normalizeString(det.producto_nombre);
            agg.byProductName.set(key, (agg.byProductName.get(key) || 0) + qty);
          }
        }
      }

      if (docs.length < PAGE_SIZE || nuevos === 0) break;
    }

    this.docsCache.set(dateStr, { at: Date.now(), byPos });

    try {
      await cacheCol.updateOne(
        { date: dateStr },
        { $set: { date: dateStr, fetchedAt: new Date(), byPos: this.serializeByPos(byPos) } },
        { upsert: true }
      );
    } catch (err: any) {
      console.warn(`⚠️ [POS] No se pudo guardar la caché Mongo de ventas (${dateStr}): ${err?.message || err}`);
    }

    return byPos;
  }

  private serializeByPos(byPos: Map<string, PosSalesAgg>): Record<string, { byId: Record<string, number>; byName: Record<string, number> }> {
    const out: Record<string, { byId: Record<string, number>; byName: Record<string, number> }> = {};
    for (const [pos, agg] of byPos) {
      out[pos] = {
        byId: Object.fromEntries(agg.byProductId),
        byName: Object.fromEntries(agg.byProductName),
      };
    }
    return out;
  }

  private deserializeByPos(raw: any): Map<string, PosSalesAgg> {
    const byPos = new Map<string, PosSalesAgg>();
    for (const [pos, agg] of Object.entries(raw || {})) {
      byPos.set(pos, {
        byProductId: new Map(Object.entries((agg as any).byId || {})),
        byProductName: new Map(Object.entries((agg as any).byName || {})),
      });
    }
    return byPos;
  }

  /**
   * Venta del día de una sucursal según Contífico, alineada a los productos
   * configurados en sus objetivos de stock. `available: false` cuando la sucursal no
   * tiene punto de emisión mapeado o Contífico falla: la pantalla nunca se
   * bloquea por esto.
   */
  async getDailySales(branch: string, dateStr?: string) {
    const ecNow = getEcuadorNow();
    const date = dateStr || ecNow.toISOString().split("T")[0];
    const empty = { branch, date, available: false, puntos: [] as string[], products: {} as Record<string, number> };

    try {
      const puntosEmision = await this.getPuntosEmisionCached();
      const codes = getBranchPuntoCodes(branch);
      const branchNorm = normalizeString(branch);
      const codeOf = (p: any) => `${p.establecimiento}-${p.punto_emision}`;

      const targets = puntosEmision.filter((p: any) => {
        if (codes) return codes.includes(codeOf(p));
        // Sin mapeo explícito: por nombre/dirección de la caja
        const label = normalizeString(`${p.nombre || ""} ${p.direccion || ""}`);
        return branchNorm.length > 3 && label.includes(branchNorm);
      });

      if (targets.length === 0) return empty;

      const byPos = await this.getDaySalesByPos(date);
      const objectives = await models.posStockObjectives.find({ branch: branchMatch(branch) }).lean();

      const sumFor = (puntos: any[]) => {
        const products: Record<string, number> = {};
        for (const obj of objectives as any[]) {
          if (obj.isGeneral) continue; // suministros manuales: no se venden en caja
          let total = 0;
          for (const target of puntos) {
            const agg = byPos.get(target.id);
            if (!agg) continue;
            const byId = obj.contificoId ? agg.byProductId.get(obj.contificoId) : undefined;
            const byName = agg.byProductName.get(normalizeString(obj.productName));
            total += byId ?? byName ?? 0;
          }
          products[obj.productName] = total;
        }
        return products;
      };

      return {
        branch,
        date,
        available: true,
        puntos: targets.map((p: any) => `${codeOf(p)} ${p.direccion || p.nombre || ""}`.trim()),
        products: sumFor(targets),
      };
    } catch (err: any) {
      console.warn(`⚠️ [POS] No se pudo leer la venta de ${branch} (${date}) en Contífico: ${err?.message || err}`);
      return empty;
    }
  }

  /**
   * Categoría de cada producto tal cual Contífico (solo subcategorías de
   * "Producto Venta", la fuente de verdad). Ver contifico-categorias.util.
   */
  private getContificoCategoryMaps() {
    return buildContificoCategoryMaps(this.contifico);
  }

  /**
   * Get all stock objectives for a branch.
   */
  async getObjectives(branch: string): Promise<IPOSStockObjective[]> {
    return models.posStockObjectives.find({ branch: branchMatch(branch) }) as any;
  }

  /**
   * Create or update a stock objective (upsert by branch + productName).
   */
  async upsertObjective(data: {
    branch: string;
    productName: string;
    unit: string;
    contificoId?: string;
    isGeneral?: boolean;
    requiresMinimum?: boolean;
    category?: "Producción" | "Bodega";
    objectives: WeeklyObjectives;
  }): Promise<IPOSStockObjective> {
    const result = await models.posStockObjectives.findOneAndUpdate(
      { branch: data.branch, productName: data.productName },
      { $set: data },
      { upsert: true, new: true }
    );
    return result as any;
  }

  /**
   * Build the daily form for a branch:
   * - Lists products with today/tomorrow objectives
   * - Shows last recorded entry per product
   * - Lists upcoming future orders (informational only)
   */
  async getDailyForm(branch: string, dateStr?: string) {
    const ecNow = getEcuadorNow();
    const formDateStr = dateStr || ecNow.toISOString().split("T")[0];
    const formDate = parseDateStr(formDateStr);

    const targetDate = new Date(formDate);
    targetDate.setUTCDate(targetDate.getUTCDate() + 1);
    const targetDateStr = toDateStr(targetDate);

    const formDow = formDate.getUTCDay();
    const targetDow = targetDate.getUTCDay();

    // All objectives for this branch + categorías tal cual Contífico
    // (producto → nombre de categoría, para las secciones del cierre).
    const [objectives, categoryMaps] = await Promise.all([
      models.posStockObjectives.find({ branch: branchMatch(branch) }).lean(),
      this.getContificoCategoryMaps(),
    ]);

    // Most recent entry for this branch on or before formDate
    const lastEntry = await models.posDailyEntries
      .findOne({ branch: branchMatch(branch), date: { $lte: formDate } })
      .sort({ date: -1 })
      .lean();

    const lastEntryItems = lastEntry ? (lastEntry.items as any[]) : [];
    const lastEntryDateStr = lastEntry ? toDateStr(lastEntry.date) : null;

    // Also fetch today's losses if any to support full state restoration (editability)
    const todayLosses = await models.posLosses.find({ branch: branchMatch(branch), date: formDate }).lean();
    const lossesByProduct: Record<string, any[]> = {};
    for (const loss of todayLosses) {
      if (!lossesByProduct[loss.productName]) lossesByProduct[loss.productName] = [];
      lossesByProduct[loss.productName].push({
        quantity: loss.quantity,
        reason: loss.reason,
        category: loss.category
      });
    }

    // Filter objectives:
    // - Catalog products (isGeneral = false) ALWAYS show.
    // - Manual items (isGeneral = true) ONLY show if:
    //   a) requiresMinimum = true
    //   b) OR they have an entry in today's report (to allow editing/restoring)
    const filteredObjectives = objectives.filter((obj: any) => {
      if (!obj.isGeneral) return true;
      if (obj.requiresMinimum) return true;

      const hasTodayEntry = lastEntryDateStr === formDateStr &&
        lastEntryItems.some((i: any) => i.productName === obj.productName);

      return hasTodayEntry;
    });

    const items = filteredObjectives.map((obj: any) => {
      const stockObjectiveToday = getObjectiveForDow(obj.objectives as WeeklyObjectives, formDow);
      const stockObjectiveTomorrow = getObjectiveForDow(obj.objectives as WeeklyObjectives, targetDow);

      let lastEntryData: any = undefined;
      const found = lastEntryItems.find(
        (i: any) => i.productName === obj.productName
      );

      if (found) {
        const isToday = lastEntryDateStr === formDateStr;
        lastEntryData = {
          stockFinal: found.stockFinal,
          bajas: found.bajas,
          pedidoSugerido: found.pedidoSugerido,
          pedidoFinal: found.pedidoFinal,
          date: lastEntryDateStr,
          // Include detailed losses only if it matches today's entry
          detailedLosses: isToday ? (lossesByProduct[obj.productName] || []) : []
        };
      }

      return {
        productName: obj.productName,
        unit: obj.unit,
        isGeneral: obj.isGeneral || false,
        requiresMinimum: obj.requiresMinimum || false,
        category: obj.category || "Producción",
        // Nombre de la categoría del producto en Contífico (null = suministro
        // manual o producto sin categoría / Contífico no disponible).
        contificoCategory: !obj.isGeneral
          ? ((obj.contificoId && categoryMaps.byId.get(obj.contificoId))
            || categoryMaps.byName.get(normalizeString(obj.productName))
            || null)
          : null,
        stockObjectiveToday,
        stockObjectiveTomorrow,
        lastEntry: lastEntryData,
      };
    });

    // Upcoming orders: deliveryDate >= targetDate, status not DELIVERED
    const upcomingOrderDocs = await models.orders
      .find({
        branch: branchMatch(branch),
        deliveryDate: { $gte: targetDate },
        status: { $nin: ["DELIVERED"] },
      })
      .select("deliveryDate products")
      .lean();

    // Group by product name
    const productMap: Record<string, { totalQuantity: number; dates: Date[]; ordersCount: number }> = {};
    for (const order of upcomingOrderDocs as any[]) {
      for (const product of order.products || []) {
        const name: string = product.name || product.productName;
        if (!name) continue;
        if (!productMap[name]) {
          productMap[name] = { totalQuantity: 0, dates: [], ordersCount: 0 };
        }
        productMap[name].totalQuantity += Number(product.quantity) || 0;
        productMap[name].dates.push(order.deliveryDate as Date);
        productMap[name].ordersCount++;
      }
    }

    const upcomingOrders = Object.entries(productMap).map(([productName, data]) => ({
      productName,
      totalQuantity: data.totalQuantity,
      nextOccurrence: data.dates.sort((a, b) => a.getTime() - b.getTime())[0],
      ordersCount: data.ordersCount,
    }));

    return {
      branch,
      formDate: formDateStr,
      targetDate: targetDateStr,
      items,
      upcomingOrders,
    };
  }

  /**
   * Save or overwrite the daily physical count and compute suggested orders.
   * pedidoSugerido = max(0, stockObjectiveTomorrow - stockFinal)
   */
  async submitDailyEntry(
    branch: string,
    dateStr: string,
    items: Array<{
      productName: string;
      bajas: number;
      bajasNote?: string;
      ventaCombo?: number;
      ventaCasaMia?: number;
      ventaDelaCrem?: number;
      stockFinal: number;
      pedidoFinal?: number;
      deliveryRounds?: Array<{ label: string; quantity: number }>;
      detailedLosses?: Array<{
        quantity: number;
        reason: string;
        category: "Transport" | "Storage" | "Production" | "Other";
      }>;
    }>,
    submittedBy: string,
    requestedByUserId?: string
  ): Promise<IPOSDailyEntry> {
    const date = parseDateStr(dateStr);

    // targetDate solo se usa para el objetivo de stock (día siguiente). El pedido
    // de reposición nace fechado el MISMO día del cierre: cocina y recepción lo
    // ven al instante (ciclo completo sin esperar al día siguiente).
    const targetDate = new Date(date);
    targetDate.setUTCDate(targetDate.getUTCDate() + 1);
    const targetDow = targetDate.getUTCDay();

    // Build objective lookup map
    const objectives = await models.posStockObjectives.find({ branch: branchMatch(branch) }).lean();
    const objectiveMap: Record<string, any> = {};
    for (const obj of objectives as any[]) {
      objectiveMap[obj.productName] = obj;
    }

    // 1. Process Detailed Losses
    const lossRecords: any[] = [];
    for (const item of items) {
      if (item.detailedLosses && item.detailedLosses.length > 0) {
        for (const loss of item.detailedLosses) {
          lossRecords.push({
            branch,
            productName: item.productName,
            quantity: loss.quantity,
            reason: loss.reason,
            category: loss.category,
            date,
            submittedBy
          });
        }
      }
    }

    // Save detailed losses (delete old ones for this branch/date/products first to allow overwrite/retry)
    const productNamesInEntry = items.map(i => i.productName);
    await models.posLosses.deleteMany({
      branch,
      date,
      productName: { $in: productNamesInEntry }
    });

    if (lossRecords.length > 0) {
      await models.posLosses.insertMany(lossRecords);
    }

    // 2. Process Entry Items
    const processedItems = items.map((item) => {
      const obj = objectiveMap[item.productName];
      const stockObjectiveTomorrow = obj
        ? getObjectiveForDow(obj.objectives as WeeklyObjectives, targetDow)
        : 0;
      const pedidoSugerido = Math.max(0, stockObjectiveTomorrow - item.stockFinal);
      const pedidoFinal = item.pedidoFinal !== undefined ? item.pedidoFinal : pedidoSugerido;

      return {
        productName: item.productName,
        unit: obj?.unit || "unidad",
        isGeneral: obj?.isGeneral || false,
        category: obj?.category || "Producción",
        bajas: item.bajas,
        bajasNote: item.bajasNote,
        ventaCombo: Math.max(0, Number(item.ventaCombo) || 0),
        ventaCasaMia: Math.max(0, Number(item.ventaCasaMia) || 0),
        ventaDelaCrem: Math.max(0, Number(item.ventaDelaCrem) || 0),
        stockFinal: item.stockFinal,
        stockObjectiveTomorrow,
        pedidoSugerido,
        pedidoFinal,
        deliveryRounds: item.deliveryRounds || [],
      };
    });

    const result = await models.posDailyEntries.findOneAndUpdate(
      { branch, date },
      {
        $set: {
          branch,
          date,
          submittedBy,
          submittedAt: new Date(),
          items: processedItems,
          status: "submitted",
        },
      },
      { upsert: true, new: true }
    );

    // 3. Sync with Production/Bodega (Order model)
    const restockItems = processedItems.filter(i => i.pedidoFinal > 0);

    // Check if any item has delivery rounds
    const hasDeliveryRounds = restockItems.some(
      (i) => i.deliveryRounds && i.deliveryRounds.length > 0
    );

    if (hasDeliveryRounds) {
      // --- Round-based sync: one Order per unique round label ---
      // Collect all unique round labels
      const roundLabels = new Set<string>();
      for (const item of restockItems) {
        if (item.deliveryRounds && item.deliveryRounds.length > 0) {
          for (const round of item.deliveryRounds) {
            roundLabels.add(round.label);
          }
        }
      }

      // Delete old restock orders for this branch/closing date (both categories)
      await models.orders.deleteMany({
        branch,
        orderDate: date,
        salesChannel: { $in: ["Restock", "Restock-Bodega"] },
      });

      // Create one Order per round label
      for (const roundLabel of roundLabels) {
        // Gather items for this round across both categories
        const categories: ("Producción" | "Bodega")[] = ["Producción", "Bodega"];

        for (const cat of categories) {
          const salesChannelLabel = cat === "Bodega" ? "Restock-Bodega" : "Restock";
          const customerNamePrefix = cat === "Bodega" ? "REPOSICIÓN BODEGA" : "REPOSICIÓN";

          const roundItems = restockItems
            .filter((i) => i.category === cat)
            .map((item) => {
              const round = (item.deliveryRounds || []).find(
                (r) => r.label === roundLabel
              );
              return round && round.quantity > 0
                ? { ...item, roundQuantity: round.quantity }
                : null;
            })
            .filter(Boolean) as Array<(typeof restockItems)[0] & { roundQuantity: number }>;

          if (roundItems.length === 0) continue;

          const restockOrderData = {
            branch,
            deliveryDate: date,
            orderDate: date,
            customerName: `${customerNamePrefix}: ${branch}`,
            customerPhone: "N/A",
            salesChannel: salesChannelLabel,
            deliveryType: "retiro",
            totalValue: 0,
            paymentMethod: "Interno",
            responsible: "Web",
            invoiceNeeded: false,
            productionStage: "PENDING",
            comments: roundLabel,
            products: roundItems.map((item) => ({
              name: item.productName,
              quantity: item.roundQuantity,
              price: 0,
              contifico_id: objectiveMap[item.productName]?.contificoId,
              productionStatus: "PENDING",
              produced: 0,
            })),
          };

          await models.orders.create(restockOrderData);
        }
      }
    } else {
      // --- Legacy: one Order per category (no rounds) ---
      const categories: ("Producción" | "Bodega")[] = ["Producción", "Bodega"];

      for (const cat of categories) {
        const catItems = restockItems.filter((i) => i.category === cat);
        const salesChannelLabel =
          cat === "Bodega" ? "Restock-Bodega" : "Restock";
        const customerNamePrefix =
          cat === "Bodega" ? "REPOSICIÓN BODEGA" : "REPOSICIÓN";

        if (catItems.length === 0) {
          await models.orders.deleteOne({
            branch,
            orderDate: date,
            salesChannel: salesChannelLabel,
          });
        } else {
          const restockOrderData = {
            branch,
            deliveryDate: date,
            orderDate: date,
            customerName: `${customerNamePrefix}: ${branch}`,
            customerPhone: "N/A",
            salesChannel: salesChannelLabel,
            deliveryType: "retiro",
            totalValue: 0,
            paymentMethod: "Interno",
            responsible: "Web",
            invoiceNeeded: false,
            productionStage: "PENDING",
            products: catItems.map((item) => ({
              name: item.productName,
              quantity: item.pedidoFinal,
              price: 0,
              contifico_id: objectiveMap[item.productName]?.contificoId,
              productionStatus: "PENDING",
              produced: 0,
            })),
          };

          await models.orders.findOneAndUpdate(
            {
              branch,
              orderDate: date,
              salesChannel: salesChannelLabel,
            },
            { $set: restockOrderData },
            { upsert: true, new: true }
          );
        }
      }
    }

    // 4. Requerimiento interno para Bodega: los ítems de categoría "Bodega" del cierre
    // deben llegar a la pantalla "Requerimientos Internos" de Supply Chain. El pedido
    // "Restock-Bodega" de arriba sólo lo ve Producción, así que sin esto Bodega nunca
    // se enteraba de lo que pedía el punto de venta.
    try {
      await this.syncBodegaRequisition({
        branch,
        closingDate: date,
        neededForDate: date,
        items: restockItems.filter((i) => i.category === "Bodega"),
        objectiveMap,
        submittedBy,
        requestedByUserId,
      });
    } catch (err: any) {
      // No se bloquea el cierre por esto: el cierre ya quedó guardado.
      console.error(`❌ [POS] No se pudo generar el requerimiento a Bodega de ${branch} (${dateStr}):`, err?.message || err);
    }

    return result as any;
  }

  /**
   * Crea o actualiza el requerimiento interno automático (source = POS_CLOSING) de
   * una sucursal para un día de cierre.
   *
   * - Si el cierre se reenvía, se actualizan los ítems mientras Bodega no lo haya
   *   despachado. Si ya está DESPACHADO/CONFIRMADO no se toca.
   * - Sin ítems de Bodega: se cancela el requerimiento pendiente si existía.
   * - Cada ítem se vincula a una materia prima por `contificoId` del objetivo o por
   *   nombre (sin distinguir mayúsculas). Si no calza, va sin materia prima: Bodega lo
   *   ve y lo despacha igual, pero no descuenta stock.
   */
  private async syncBodegaRequisition(params: {
    branch: string;
    closingDate: Date;
    neededForDate: Date;
    items: Array<{ productName: string; unit: string; pedidoFinal: number }>;
    objectiveMap: Record<string, any>;
    submittedBy: string;
    requestedByUserId?: string;
  }): Promise<void> {
    const { branch, closingDate, neededForDate, items, objectiveMap, submittedBy, requestedByUserId } = params;

    const existing = await models.internalRequisitions.findOne({
      source: "POS_CLOSING",
      branch,
      closingDate,
    });

    if (existing && ["DISPATCHED", "CONFIRMED"].includes(existing.status)) {
      console.log(`ℹ️ [POS] Requerimiento a Bodega de ${branch} ya está ${existing.status}; no se modifica.`);
      return;
    }

    if (items.length === 0) {
      if (existing && existing.status !== "CANCELLED") {
        existing.status = "CANCELLED";
        existing.notes = `${existing.notes ? existing.notes + " · " : ""}Cancelado: el cierre se reenvió sin ítems de Bodega.`;
        await existing.save();
      }
      return;
    }

    // Vincular con materias primas
    const sinVincular: string[] = [];
    const reqItems: any[] = [];
    for (const item of items) {
      const contificoId = objectiveMap[item.productName]?.contificoId;
      let material: any = null;
      if (contificoId) {
        material = await models.rawMaterials.findOne({ contificoId }).lean();
      }
      if (!material) {
        const escaped = item.productName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        material = await models.rawMaterials.findOne({ name: { $regex: `^${escaped}$`, $options: "i" } }).lean();
      }
      if (!material) sinVincular.push(item.productName);

      reqItems.push({
        material: material?._id,
        name: item.productName,
        quantity: item.pedidoFinal,
        unit: material?.unit || item.unit || "unidad",
      });
    }

    const fecha = closingDate.toISOString().slice(0, 10).split("-").reverse().join("/");
    const notes = [
      `Generado automáticamente desde el cierre de producción de ${branch} (${fecha}).`,
      sinVincular.length ? `Sin materia prima vinculada (no descuentan stock): ${sinVincular.join(", ")}.` : "",
    ].filter(Boolean).join(" ");

    const payload = {
      source: "POS_CLOSING" as const,
      branch,
      closingDate,
      requestedBy: requestedByUserId || undefined,
      requestedByName: submittedBy && submittedBy !== "POS User" ? `${submittedBy} · ${branch}` : `Cierre POS · ${branch}`,
      area: `Punto de venta ${branch}`,
      neededForDate,
      items: reqItems,
      notes,
    };

    if (existing) {
      existing.set({ ...payload, status: "REQUESTED" });
      await existing.save();
      console.log(`🔄 [POS] Requerimiento a Bodega de ${branch} (${fecha}) actualizado: ${reqItems.length} ítems.`);
    } else {
      await models.internalRequisitions.create({ ...payload, status: "REQUESTED" });
      console.log(`✅ [POS] Requerimiento a Bodega de ${branch} (${fecha}) creado: ${reqItems.length} ítems.`);
    }
  }

  /**
   * Get entry history for a branch within a date range (inclusive).
   */
  async getHistory(branch: string, fromDate: string, toDate: string): Promise<IPOSDailyEntry[]> {
    const from = parseDateStr(fromDate);
    const to = parseDateStr(toDate);
    to.setUTCHours(23, 59, 59, 999);

    return models.posDailyEntries
      .find({ branch, date: { $gte: from, $lte: to } })
      .sort({ date: -1 })
      .lean() as any;
  }
  /**
   * Delete a stock objective by branch and product name.
   */
  async deleteObjective(branch: string, productName: string): Promise<boolean> {
    const result = await models.posStockObjectives.deleteOne({ branch: branchMatch(branch), productName });
    return result.deletedCount > 0;
  }

  /**
   * F10 — Sobrantes de cierre de día en punto de venta.
   *
   * Devuelve, por día y sucursal, cuántas unidades quedaron al cerrar (stockFinal),
   * cuánto se recibió ese día y la venta implícita que cuadra el inventario:
   *
   *   stockFinal(d-1) + recibido(d) - bajas(d) - stockFinal(d) = ventaImplicita(d)
   *
   * Si no existe cierre del día anterior no hay stock inicial: entonces lo
   * recibido del día hace de stock inicial y la venta implícita se calcula
   * desde ahí (recibido - bajas - stockFinal). `stockInicial` se devuelve en
   * null para que la pantalla muestre que no hubo cierre previo.
   */
  async getLeftovers(params: { from: string; to: string; branch?: string }) {
    const { from, to, branch } = params;
    const fromDate = parseDateStr(from);
    const toDate = parseDateStr(to);
    toDate.setUTCHours(23, 59, 59, 999);

    // Día previo al rango: necesario para el stock inicial del primer día.
    const prevDate = new Date(fromDate);
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);

    const allBranches = branch && branch !== "all";
    const entryQuery: any = { date: { $gte: prevDate, $lte: toDate } };
    if (allBranches) entryQuery.branch = branchMatch(branch as string);

    const entries = (await models.posDailyEntries
      .find(entryQuery)
      .sort({ date: 1 })
      .lean()) as any[];

    // Sucursales a considerar: las activas (o la filtrada) + las que ya tienen cierres.
    let branchNames: string[];
    if (allBranches) {
      branchNames = [branch as string];
    } else {
      const active = (await models.branches
        .find({ isActive: true })
        .sort({ sortOrder: 1 })
        .lean()) as any[];
      const fromDb = active.map((b) => b.name);
      const fromEntries = entries.map((e) => e.branch);
      branchNames = Array.from(new Set([...fromDb, ...fromEntries]));
    }

    const branchKey = (b: string) => b.trim().toLowerCase();
    const allowed = new Set(branchNames.map(branchKey));

    // Recepciones confirmadas en el rango: dispatch.destination = sucursal.
    const received = await this.getReceivedByDay(fromDate, toDate);

    // Índice de cierres: `${branchKey}|${YYYY-MM-DD}|${producto}` → item
    const entryIndex = new Map<string, any>();
    const daysWithEntry = new Set<string>();
    for (const entry of entries) {
      const dateStr = toDateStr(new Date(entry.date));
      const bk = branchKey(entry.branch);
      if (!allowed.has(bk)) continue;
      daysWithEntry.add(`${bk}|${dateStr}`);
      for (const item of entry.items || []) {
        entryIndex.set(`${bk}|${dateStr}|${item.productName}`, { ...item, entry });
      }
    }

    // Recorrer día por día del rango solicitado.
    const rows: any[] = [];
    const missing: Array<{ date: string; branch: string }> = [];

    const cursor = new Date(fromDate);
    while (cursor <= toDate) {
      const dateStr = toDateStr(cursor);
      const prev = new Date(cursor);
      prev.setUTCDate(prev.getUTCDate() - 1);
      const prevStr = toDateStr(prev);

      for (const bName of branchNames) {
        const bk = branchKey(bName);
        if (!daysWithEntry.has(`${bk}|${dateStr}`)) {
          missing.push({ date: dateStr, branch: bName });
          continue;
        }

        const entry = entries.find(
          (e) => branchKey(e.branch) === bk && toDateStr(new Date(e.date)) === dateStr
        );
        if (!entry) continue;

        for (const item of entry.items || []) {
          const prevItem = entryIndex.get(`${bk}|${prevStr}|${item.productName}`);
          const stockInicial = prevItem ? prevItem.stockFinal : null;
          const recibido = received.get(`${bk}|${dateStr}|${item.productName}`) ?? 0;
          const bajas = item.bajas ?? 0;
          const stockFinal = item.stockFinal ?? 0;

          rows.push({
            date: dateStr,
            branch: entry.branch,
            productName: item.productName,
            unit: item.unit,
            stockInicial,
            recibido,
            bajas,
            bajasNote: item.bajasNote,
            ventaCombo: item.ventaCombo ?? 0,
            ventaCasaMia: item.ventaCasaMia ?? 0,
            ventaDelaCrem: item.ventaDelaCrem ?? 0,
            stockFinal,
            stockObjectiveTomorrow: item.stockObjectiveTomorrow ?? 0,
            pedidoFinal: item.pedidoFinal ?? 0,
            // Sin cierre previo, el recibido es el punto de partida.
            ventaImplicita: (stockInicial ?? 0) + recibido - bajas - stockFinal,
            submittedBy: entry.submittedBy,
            submittedAt: entry.submittedAt,
          });
        }
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const totals = rows.reduce(
      (acc, r) => {
        acc.stockFinal += r.stockFinal;
        acc.bajas += r.bajas;
        acc.recibido += r.recibido;
        if (r.ventaImplicita !== null) acc.ventaImplicita += r.ventaImplicita;
        return acc;
      },
      { stockFinal: 0, bajas: 0, recibido: 0, ventaImplicita: 0 }
    );

    return {
      rows,
      totals: { ...totals, rows: rows.length },
      branches: branchNames,
      missing,
    };
  }

  /**
   * Suma lo recibido por sucursal/día/producto a partir de los despachos
   * confirmados en el POS. Usa `quantityReceived` cuando existe (recepción
   * con checklist) y cae a `quantitySent` cuando no se detalló.
   */
  private async getReceivedByDay(fromDate: Date, toDate: Date): Promise<Map<string, number>> {
    const fromStr = toDateStr(fromDate);
    const toStr = toDateStr(toDate);

    const orders = (await models.orders
      .find(
        {
          // PROBLEM = recibido con novedad: también cuenta como recibido
          "dispatches.receptionStatus": { $in: ["RECEIVED", "PROBLEM"] },
          ...receptionCandidatesQuery(fromStr, toStr),
        },
        { dispatches: 1, salesChannel: 1, orderDate: 1 }
      )
      .lean()) as any[];

    const map = new Map<string, number>();
    for (const order of orders) {
      for (const dispatch of order.dispatches || []) {
        if (!["RECEIVED", "PROBLEM"].includes(dispatch.receptionStatus) || !dispatch.receivedAt) continue;

        // Reposición: cuenta en el cierre siguiente al que la pidió
        const ecDay = receptionDayOf(order, dispatch.receivedAt);
        if (ecDay < fromStr || ecDay > toStr) continue;
        const bk = String(dispatch.destination || "").trim().toLowerCase();
        if (!bk) continue;

        for (const item of dispatch.items || []) {
          const qty = item.quantityReceived ?? item.quantitySent ?? 0;
          const key = `${bk}|${ecDay}|${item.name}`;
          map.set(key, (map.get(key) ?? 0) + qty);
        }
      }
    }
    return map;
  }
}
