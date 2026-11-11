import { models } from "../models";
import { ContificoService } from "./contifico.service";
import { getEcuadorNow } from "../utils/date.utils";
import {
  PRODUCTION_CATALOG,
  PRODUCTION_AREAS,
  DEFAULT_PRODUCTION_OPERATORS,
  PRODUCTION_RULES,
  ProductionCompany,
} from "../config/production-catalog.config";

/**
 * Ingreso de producción (tablet de planta) e Histórico (panel del Jefe de Operaciones).
 *
 * Reglas de Operaciones (11/11/2026):
 * - Semanas de lunes a domingo. Se permiten 2 días sin ingreso por semana (descansos rotativos).
 *   Desde el 3.º, cada día suma $3. La multa se calcula al cerrar la semana (domingo).
 * - Índice del mes = Registro diario 30% + Productividad vs área 40% + Valor producido vs área 30%.
 */

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

const nameKeyOf = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
const prettyName = (name: string) => {
  const clean = name.trim().replace(/\s+/g, " ");
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
};

/** AAAA-MM-DD de hoy en Ecuador. */
const todayStr = () => getEcuadorNow().toISOString().split("T")[0];
/** AAAA-MM-DD en Ecuador de un instante. */
const ecDateOf = (d: Date) => new Date(d.getTime() - 5 * 3600000).toISOString().split("T")[0];

const parse = (s: string) => new Date(`${s}T00:00:00.000Z`);
const fmt = (d: Date) => d.toISOString().split("T")[0];
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
const minStr = (a: string, b: string) => (a < b ? a : b);
const maxStr = (a: string, b: string) => (a > b ? a : b);
const daysBetween = (from: string, to: string) =>
  from > to ? 0 : Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000) + 1;
/** Lunes de la semana del día dado. */
const mondayOf = (s: string) => {
  const dow = (parse(s).getUTCDay() + 6) % 7; // 0 = lunes
  return addDays(s, -dow);
};

const catalogIndex = (company: ProductionCompany) =>
  new Map(PRODUCTION_CATALOG[company].map((p) => [p.code.toLowerCase(), p]));

export class ProductionEntryService {
  private contifico = {
    nicole: new ContificoService("nicole"),
    sucree: new ContificoService("sucree"),
  };

  /** Crea los operarios iniciales solo si la lista está vacía. */
  private async ensureDefaults() {
    const count = await models.productionOperators.countDocuments();
    if (count > 0) return;
    await models.productionOperators.insertMany(
      DEFAULT_PRODUCTION_OPERATORS.map((name) => ({ name, nameKey: nameKeyOf(name), createdBy: "sistema" })),
      { ordered: false }
    ).catch(() => undefined); // otra petición pudo crearlos al mismo tiempo
  }

  /** Lo que necesita la tablet: operarios activos, áreas y catálogo por empresa. */
  async getTabletData() {
    await this.ensureDefaults();
    const operators = (await models.productionOperators
      .find({ active: true })
      .sort({ name: 1 })
      .select("name")
      .lean()) as any[];
    return {
      today: todayStr(),
      operators: operators.map((o) => ({ id: String(o._id), name: o.name })),
      areas: PRODUCTION_AREAS,
      catalog: PRODUCTION_CATALOG,
      rules: { freeDaysPerWeek: PRODUCTION_RULES.freeDaysPerWeek, finePerDay: PRODUCTION_RULES.finePerDay },
    };
  }

  /** Guarda un ingreso y reemplaza la foto del operario por la selfie nueva. */
  async createEntry(body: any, createdBy: string) {
    const { operatorId, company, area, items, photo } = body || {};

    if (company !== "nicole" && company !== "sucree") throw badRequest("Elige la empresa: Nicole o Sucrée.");
    if (!PRODUCTION_AREAS.includes(area)) throw badRequest("Elige el área.");
    if (typeof photo !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) {
      throw badRequest("Falta la selfie.");
    }
    if (photo.length > PRODUCTION_RULES.maxPhotoChars) throw badRequest("La foto es demasiado grande. Tómala de nuevo.");

    const operator = (await models.productionOperators.findOne({ _id: operatorId, active: true }).catch(() => null)) as any;
    if (!operator) throw badRequest("Ese operario no está en la lista. Pide al Jefe de Operaciones que lo agregue.");

    if (!Array.isArray(items) || items.length === 0) throw badRequest("Agrega al menos un producto.");
    const index = catalogIndex(company);
    const merged = new Map<string, { code: string; name: string; category: string; quantity: number }>();
    for (const it of items) {
      const product = index.get(String(it?.code || "").toLowerCase());
      if (!product) throw badRequest(`El producto ${it?.code ?? ""} no está en el catálogo de ${company === "nicole" ? "Nicole" : "Sucrée"}.`);
      const quantity = Number(it?.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2000) {
        throw badRequest(`Cantidad inválida para ${product.name}.`);
      }
      const prev = merged.get(product.code);
      if (prev) prev.quantity += quantity;
      else merged.set(product.code, { ...product, quantity });
    }
    const list = Array.from(merged.values());

    const entry = await models.productionEntries.create({
      date: todayStr(),
      operator: operator._id,
      operatorName: operator.name,
      company,
      area,
      items: list,
      totalUnits: list.reduce((s, i) => s + i.quantity, 0),
      createdBy,
    });

    operator.photo = photo;
    operator.photoAt = new Date();
    await operator.save();

    return {
      id: String(entry._id),
      date: entry.date,
      operatorName: entry.operatorName,
      totalUnits: entry.totalUnits,
      createdAt: entry.createdAt,
    };
  }

  // ───────────────────────── Operarios (Jefe de Operaciones) ─────────────────────────

  async listOperators() {
    await this.ensureDefaults();
    const operators = (await models.productionOperators.find({ active: true }).sort({ name: 1 }).lean()) as any[];
    const last = (await models.productionEntries.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$operator", createdAt: { $first: "$createdAt" } } },
    ])) as any[];
    const lastBy = new Map(last.map((l) => [String(l._id), l.createdAt]));
    return operators.map((o) => ({
      id: String(o._id),
      name: o.name,
      photo: o.photo,
      lastEntryAt: lastBy.get(String(o._id)) || null,
      createdAt: o.createdAt,
    }));
  }

  async addOperator(rawName: string, by: string) {
    if (typeof rawName !== "string" || !rawName.trim()) throw badRequest("Escribe el nombre del operario.");
    if (rawName.trim().length > 60) throw badRequest("El nombre es demasiado largo.");
    const nameKey = nameKeyOf(rawName);
    const existing = (await models.productionOperators.findOne({ nameKey })) as any;
    if (existing?.active) throw badRequest(`${existing.name} ya está en la lista.`);
    if (existing) {
      // Vuelve a la lista con su historial
      existing.active = true;
      existing.deactivatedAt = null;
      existing.deactivatedBy = null;
      await existing.save();
      return { id: String(existing._id), name: existing.name, reactivated: true };
    }
    const created = await models.productionOperators.create({ name: prettyName(rawName), nameKey, createdBy: by });
    return { id: String(created._id), name: created.name, reactivated: false };
  }

  /** Borrar = sacarlo de la tablet. Sus ingresos y su ficha se conservan. */
  async removeOperator(id: string, by: string) {
    const operator = (await models.productionOperators.findOne({ _id: id, active: true }).catch(() => null)) as any;
    if (!operator) throw badRequest("Ese operario ya no está en la lista.");
    operator.active = false;
    operator.deactivatedAt = new Date();
    operator.deactivatedBy = by;
    await operator.save();
    return { id: String(operator._id), name: operator.name };
  }

  // ───────────────────────── Histórico (Jefe de Operaciones) ─────────────────────────

  /** PVP sin IVA por código, de las dos empresas. Si Contífico no responde, el valor queda en 0. */
  private async priceIndex() {
    const prices = { nicole: new Map<string, number>(), sucree: new Map<string, number>() };
    let available = true;
    for (const company of ["nicole", "sucree"] as const) {
      try {
        const products = (await this.contifico[company].getCachedProducts()) as any[];
        for (const p of products || []) {
          if (p?.codigo) prices[company].set(String(p.codigo).toLowerCase(), Number(p.pvp1) || 0);
        }
      } catch (err) {
        available = false;
        console.error(`Histórico de producción: sin precios de Contífico (${company})`, err);
      }
    }
    return { prices, available };
  }

  /**
   * Histórico del mes (AAAA-MM): ingresos, ficha de cada operario, índice y multas semanales.
   * Las multas son de las semanas que cierran (domingo) dentro del mes.
   */
  async getHistory(month?: string) {
    const today = todayStr();
    const m = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : today.slice(0, 7);
    const monthStart = `${m}-01`;
    const next = parse(monthStart);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const monthEnd = addDays(fmt(next), -1);
    const periodEnd = minStr(monthEnd, today); // no se cuentan días futuros

    // Semanas que cierran en el mes, más la semana en curso si el mes es el actual.
    const weeks: Array<{ from: string; to: string }> = [];
    for (let mon = mondayOf(monthStart); mon <= monthEnd; mon = addDays(mon, 7)) {
      const sun = addDays(mon, 6);
      if (sun < monthStart) continue;
      if (sun > monthEnd && !(today >= mon && today <= sun)) continue; // la cierra el mes siguiente
      if (mon > today) continue;
      weeks.push({ from: mon, to: sun });
    }
    const queryFrom = weeks.length ? minStr(weeks[0].from, monthStart) : monthStart;
    const queryTo = weeks.length ? maxStr(weeks[weeks.length - 1].to, monthEnd) : monthEnd;

    const [entries, operatorsDocs, priceData] = await Promise.all([
      models.productionEntries
        .find({ date: { $gte: queryFrom, $lte: queryTo } })
        .sort({ createdAt: -1 })
        .lean() as Promise<any[]>,
      models.productionOperators.find({}).lean() as Promise<any[]>,
      this.priceIndex(),
    ]);

    const valueOf = (e: any) =>
      (e.items || []).reduce(
        (s: number, i: any) => s + i.quantity * (priceData.prices[e.company as ProductionCompany].get(String(i.code).toLowerCase()) || 0),
        0
      );
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const monthEntries = entries
      .filter((e) => e.date >= monthStart && e.date <= monthEnd)
      .map((e) => ({
        id: String(e._id),
        date: e.date,
        createdAt: e.createdAt,
        operatorId: String(e.operator),
        operatorName: e.operatorName,
        company: e.company,
        area: e.area,
        totalUnits: e.totalUnits,
        value: round2(valueOf(e)),
        items: (e.items || []).map((i: any) => ({
          code: i.code,
          name: i.name,
          category: i.category,
          quantity: i.quantity,
          unitPrice: priceData.prices[e.company as ProductionCompany].get(String(i.code).toLowerCase()) || 0,
        })),
      }));

    // Operarios: los activos y los que tuvieron ingresos en el mes aunque ya no estén.
    const withEntries = new Set(monthEntries.map((e) => e.operatorId));
    const operators = operatorsDocs.filter((o) => o.active || withEntries.has(String(o._id)));

    const { freeDaysPerWeek, finePerDay, weights } = PRODUCTION_RULES;
    const rows = operators.map((o) => {
      const id = String(o._id);
      const mine = monthEntries.filter((e) => e.operatorId === id);
      const daysWithEntry = new Set(entries.filter((e) => String(e.operator) === id).map((e) => e.date));
      const monthDays = new Set(mine.map((e) => e.date));
      const units = mine.reduce((s, e) => s + e.totalUnits, 0);
      const value = mine.reduce((s, e) => s + e.value, 0);
      const areaCount = new Map<string, number>();
      mine.forEach((e) => areaCount.set(e.area, (areaCount.get(e.area) || 0) + 1));
      const mainArea = Array.from(areaCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      // Desde cuándo se le cuenta: no se multan días anteriores a su alta.
      const since = ecDateOf(new Date(o.createdAt));
      const until = o.active ? today : ecDateOf(new Date(o.deactivatedAt || o.updatedAt));

      const weekRows = weeks.map((w) => {
        const from = maxStr(w.from, since);
        const to = minStr(minStr(w.to, today), until);
        let without = 0;
        for (let d = from; d <= to; d = addDays(d, 1)) if (!daysWithEntry.has(d)) without++;
        const closed = w.to < today;
        const extra = Math.max(0, without - freeDaysPerWeek);
        return { from: w.from, to: w.to, closed, daysWithoutEntry: without, freeDays: freeDaysPerWeek, extraDays: closed ? extra : 0, fine: closed ? extra * finePerDay : 0 };
      });

      // Días esperados en el mes: días transcurridos menos los 2 libres de cada semana cerrada.
      let expected = 0;
      for (const w of weeks) {
        const from = maxStr(maxStr(w.from, monthStart), since);
        const to = minStr(minStr(minStr(w.to, periodEnd), until), monthEnd);
        const n = daysBetween(from, to);
        expected += Math.max(0, n - (w.to < today ? freeDaysPerWeek : 0));
      }

      return {
        id,
        name: o.name,
        active: !!o.active,
        photo: o.photo || null,
        mainArea,
        entries: mine.length,
        units,
        value: round2(value),
        daysWithEntry: monthDays.size,
        expectedDays: expected,
        unitsPerDay: monthDays.size ? units / monthDays.size : 0,
        weeks: weekRows,
        fines: weekRows.reduce((s, w) => s + w.fine, 0),
        extraDays: weekRows.reduce((s, w) => s + w.extraDays, 0),
      };
    });

    // Índice: se compara a cada operario con el promedio de su área principal.
    const byArea = new Map<string, typeof rows>();
    rows.forEach((r) => {
      if (!r.mainArea) return;
      byArea.set(r.mainArea, [...(byArea.get(r.mainArea) || []), r]);
    });
    const operatorsOut = rows
      .map((r) => {
        const peers = (r.mainArea && byArea.get(r.mainArea)) || [];
        const areaUnitsPerDay = peers.length ? peers.reduce((s, p) => s + p.unitsPerDay, 0) / peers.length : 0;
        const areaValue = peers.length ? peers.reduce((s, p) => s + p.value, 0) / peers.length : 0;
        const registro = r.expectedDays ? Math.min(100, Math.round((r.daysWithEntry / r.expectedDays) * 100)) : r.daysWithEntry ? 100 : 0;
        const productividad = areaUnitsPerDay ? Math.min(100, Math.round((r.unitsPerDay / areaUnitsPerDay) * 92)) : 0;
        const valor = areaValue ? Math.min(100, Math.round((r.value / areaValue) * 92)) : 0;
        const index = Math.round(registro * weights.registro + productividad * weights.productividad + valor * weights.valor);
        return {
          ...r,
          unitsPerDay: round2(r.unitsPerDay),
          areaUnitsPerDay: round2(areaUnitsPerDay),
          score: { registro, productividad, valor, index },
        };
      })
      .sort((a, b) => b.score.index - a.score.index);

    return {
      month: m,
      today,
      rules: { freeDaysPerWeek, finePerDay, weights },
      pricesAvailable: priceData.available,
      totals: {
        entries: monthEntries.length,
        units: monthEntries.reduce((s, e) => s + e.totalUnits, 0),
        value: round2(monthEntries.reduce((s, e) => s + e.value, 0)),
        fines: operatorsOut.reduce((s, o) => s + o.fines, 0),
        extraDays: operatorsOut.reduce((s, o) => s + o.extraDays, 0),
        activeOperators: operatorsOut.filter((o) => o.active).length,
      },
      operators: operatorsOut,
      entries: monthEntries,
    };
  }
}

export const productionEntryService = new ProductionEntryService();
