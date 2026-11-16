import { Types } from "mongoose";
import { models } from "../models";
import { getEcuadorNow } from "../utils/date.utils";
import { PRODUCTION_CATALOG } from "../config/production-catalog.config";
import {
  InventoryCompany,
  InventoryBlock,
  InventoryProductBlock,
  INVENTORY_COMPANIES,
  INVENTORY_BLOCKS,
  INVENTORY_PRODUCT_BLOCKS,
  INVENTORY_BLOCK_TITLES,
  INVENTORY_DEFAULT_UNIT,
  INVENTORY_DEFAULT_UNITS,
  INVENTORY_RULES,
} from "../config/inventory.config";

/**
 * Inventario semanal (toma de los lunes).
 * - Productos en tres bloques: producto terminado (pt), en proceso (pp) y materia prima (mp).
 * - Utensilios (ut): cada uno con foto; cada semana se cuenta y se compara con las anteriores.
 * - Se puede pasar de un bloque a otro sin cerrarlo; un bloque cerrado ya no se edita.
 * - El catálogo (categorías, productos, unidades) lo edita el Jefe de Operaciones en Ajustes.
 */

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

const clean = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");
const keyOf = (v: string) => clean(v).toLowerCase();

const todayStr = () => getEcuadorNow().toISOString().split("T")[0];
/** Lunes (AAAA-MM-DD) de la semana del día dado. */
const mondayOf = (s: string) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().split("T")[0];
};

function companyOf(v: unknown): InventoryCompany {
  const c = String(v || "").toLowerCase() as InventoryCompany;
  if (!INVENTORY_COMPANIES.includes(c)) throw badRequest("Empresa no válida. Usa nicole o sucree.");
  return c;
}

function blockOf(v: unknown): InventoryBlock {
  const b = String(v || "").toLowerCase() as InventoryBlock;
  if (!INVENTORY_BLOCKS.includes(b)) throw badRequest("Bloque no válido.");
  return b;
}

function nameOf(v: unknown, what: string): string {
  const n = clean(v);
  if (!n) throw badRequest(`Falta el nombre de ${what}.`);
  if (n.length > INVENTORY_RULES.maxNameChars) throw badRequest(`El nombre de ${what} es muy largo.`);
  return n;
}

function quantityOf(v: unknown, integer: boolean): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > INVENTORY_RULES.maxQuantity) throw badRequest("Hay una cantidad no válida.");
  if (integer && !Number.isInteger(n)) throw badRequest("Los utensilios se cuentan en números enteros.");
  return Math.round(n * 1000) / 1000;
}

/** Catálogo inicial: producto terminado arranca con el listado de producción de la empresa. */
function defaultCatalog(company: InventoryCompany) {
  const byCategory = new Map<string, Array<{ code: string; name: string; unit: string }>>();
  for (const p of PRODUCTION_CATALOG[company]) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push({ code: p.code, name: p.name, unit: INVENTORY_DEFAULT_UNIT.pt });
  }
  return {
    company,
    units: [...INVENTORY_DEFAULT_UNITS],
    blocks: INVENTORY_PRODUCT_BLOCKS.map((key) => ({
      key,
      title: INVENTORY_BLOCK_TITLES[key],
      categories:
        key === "pt" ? Array.from(byCategory, ([name, products]) => ({ name, products })) : [],
    })),
    updatedBy: "sistema",
  };
}

const catalogView = (c: any) => ({
  company: c.company,
  units: c.units,
  blocks: INVENTORY_PRODUCT_BLOCKS.map((key) => {
    const b = (c.blocks || []).find((x: any) => x.key === key);
    return {
      key,
      title: b?.title || INVENTORY_BLOCK_TITLES[key],
      categories: (b?.categories || []).map((cat: any) => ({
        name: cat.name,
        products: (cat.products || []).map((p: any) => ({ code: p.code, name: p.name, unit: p.unit })),
      })),
    };
  }),
  updatedBy: c.updatedBy,
  updatedAt: c.updatedAt || null,
});

export class InventoryService {
  /** Catálogo de la empresa; si todavía no existe, se crea con el listado inicial. */
  async getCatalog(companyRaw: unknown) {
    const company = companyOf(companyRaw);
    let doc = await models.inventoryCatalogs.findOne({ company }).lean();
    if (!doc) {
      await models.inventoryCatalogs.create(defaultCatalog(company)).catch((e: any) => {
        if (e?.code !== 11000) throw e; // otra petición lo creó al mismo tiempo
      });
      doc = await models.inventoryCatalogs.findOne({ company }).lean();
    }
    return catalogView(doc);
  }

  /** Ajustes: reemplaza el catálogo completo (bloques, categorías, productos y unidades). */
  async saveCatalog(body: any, user: string) {
    const company = companyOf(body?.company);

    const unitsIn: unknown[] = Array.isArray(body?.units) ? body.units : [];
    const units: string[] = [];
    for (const u of unitsIn) {
      const n = clean(u);
      if (n && !units.some((x) => keyOf(x) === keyOf(n))) units.push(n.slice(0, 20));
    }
    if (!units.length) throw badRequest("Deja al menos una unidad de medida.");
    if (units.length > INVENTORY_RULES.maxUnits) throw badRequest("Hay demasiadas unidades de medida.");

    const blocksIn: any[] = Array.isArray(body?.blocks) ? body.blocks : [];
    const blocks = INVENTORY_PRODUCT_BLOCKS.map((key) => {
      const b = blocksIn.find((x) => x?.key === key) || {};
      const title = clean(b.title) || INVENTORY_BLOCK_TITLES[key];
      if (title.length > 60) throw badRequest("El nombre del bloque es muy largo.");

      const catsIn: any[] = Array.isArray(b.categories) ? b.categories : [];
      if (catsIn.length > INVENTORY_RULES.maxCategories) throw badRequest(`Hay demasiadas categorías en ${title}.`);
      const catNames = new Set<string>();
      const codes = new Set<string>();
      let total = 0;
      const categories = catsIn.map((cat) => {
        const name = nameOf(cat?.name, `una categoría de ${title}`);
        if (catNames.has(keyOf(name))) throw badRequest(`La categoría "${name}" está repetida en ${title}.`);
        catNames.add(keyOf(name));
        const prodsIn: any[] = Array.isArray(cat?.products) ? cat.products : [];
        total += prodsIn.length;
        if (total > INVENTORY_RULES.maxProductsPerBlock) throw badRequest(`Hay demasiados productos en ${title}.`);
        const products = prodsIn.map((p) => {
          const pname = nameOf(p?.name, `un producto de ${name}`);
          const code = clean(p?.code).slice(0, 30);
          if (!code) throw badRequest(`Falta el código de "${pname}".`);
          if (codes.has(keyOf(code))) throw badRequest(`El código ${code} está repetido en ${title}.`);
          codes.add(keyOf(code));
          const unit = units.find((u) => keyOf(u) === keyOf(clean(p?.unit))) || units[0];
          return { code, name: pname, unit };
        });
        return { name, products };
      });
      return { key, title, categories };
    });

    const doc = await models.inventoryCatalogs
      .findOneAndUpdate(
        { company },
        { $set: { blocks, units, updatedBy: user } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      )
      .lean();
    return catalogView(doc);
  }

  /** Utensilios activos de la empresa, con su foto. */
  private async utensils(company: InventoryCompany) {
    const list = (await models.inventoryUtensils
      .find({ company, active: true })
      .sort({ createdAt: 1 })
      .select("name photo createdAt")
      .lean()) as any[];
    return list.map((u) => ({ id: String(u._id), name: u.name, photo: u.photo }));
  }

  private countView(c: any, weekOf: string, company: InventoryCompany) {
    const block = (k: InventoryBlock) => {
      const b = c?.[k] || {};
      return {
        status: b.status === "closed" ? "closed" : "open",
        items: (b.items || []).map((i: any) =>
          k === "ut"
            ? { utensilId: String(i.utensil), name: i.name, quantity: i.quantity }
            : { code: i.code, name: i.name, category: i.category, quantity: i.quantity, unit: i.unit }
        ),
        closedAt: b.closedAt || null,
        closedBy: b.closedBy || null,
      };
    };
    return {
      company,
      weekOf,
      responsible: c?.responsible || "",
      pt: block("pt"),
      pp: block("pp"),
      mp: block("mp"),
      ut: block("ut"),
    };
  }

  /** Toma de la semana en curso + utensilios + conteos de utensilios de semanas anteriores. */
  async getWeek(companyRaw: unknown) {
    const company = companyOf(companyRaw);
    const today = todayStr();
    const weekOf = mondayOf(today);
    const [count, utensils, previous] = await Promise.all([
      models.inventoryCounts.findOne({ company, weekOf }).lean(),
      this.utensils(company),
      models.inventoryCounts
        .find({ company, weekOf: { $lt: weekOf } })
        .sort({ weekOf: -1 })
        .limit(INVENTORY_RULES.historyWeeks)
        .select("weekOf ut.items")
        .lean(),
    ]);
    const history = (previous as any[])
      .reverse()
      .map((c) => ({
        weekOf: c.weekOf,
        utensils: Object.fromEntries((c.ut?.items || []).map((i: any) => [String(i.utensil), i.quantity])),
      }));
    return { today, weekOf, count: this.countView(count, weekOf, company), utensils, history };
  }

  /** Guarda lo contado en un bloque (reemplaza la lista del bloque). */
  async saveBlock(blockRaw: unknown, body: any, user: string) {
    const company = companyOf(body?.company);
    const block = blockOf(blockRaw);
    const weekOf = mondayOf(todayStr());
    const itemsIn: any[] = Array.isArray(body?.items) ? body.items : [];

    let items: any[];
    if (block === "ut") {
      const active = await models.inventoryUtensils.find({ company, active: true }).select("name").lean();
      const byId = new Map((active as any[]).map((u) => [String(u._id), u.name]));
      const seen = new Set<string>();
      items = itemsIn.map((i) => {
        const id = String(i?.utensilId || "");
        if (!byId.has(id)) throw badRequest("Hay un utensilio que ya no existe. Recarga la página.");
        if (seen.has(id)) throw badRequest("Hay un utensilio repetido.");
        seen.add(id);
        return { utensil: new Types.ObjectId(id), name: byId.get(id), quantity: quantityOf(i?.quantity, true) };
      });
    } else {
      const catalog = await this.getCatalog(company);
      const cat = catalog.blocks.find((b) => b.key === block)!;
      const byCode = new Map<string, { code: string; name: string; unit: string; category: string }>();
      for (const c of cat.categories) for (const p of c.products) byCode.set(keyOf(p.code), { ...p, category: c.name });
      const seen = new Set<string>();
      items = itemsIn.map((i) => {
        const p = byCode.get(keyOf(clean(i?.code)));
        if (!p) throw badRequest(`El producto ${clean(i?.code)} ya no está en el catálogo. Recarga la página.`);
        const unit = (catalog.units as string[]).find((u) => keyOf(u) === keyOf(clean(i?.unit))) || p.unit;
        const k = `${keyOf(p.code)}|${keyOf(unit)}`;
        if (seen.has(k)) throw badRequest(`"${p.name}" está repetido con la misma unidad.`);
        seen.add(k);
        return { code: p.code, name: p.name, category: p.category, quantity: quantityOf(i?.quantity, false), unit };
      });
    }

    const set: Record<string, unknown> = { [`${block}.items`]: items, [`${block}.updatedBy`]: user };
    const responsible = clean(body?.responsible).slice(0, 60);
    if (responsible) set.responsible = responsible;

    // Solo se escribe si el bloque no está cerrado.
    const filter = { company, weekOf, [`${block}.status`]: { $ne: "closed" } };
    try {
      const doc = await models.inventoryCounts
        .findOneAndUpdate(filter, { $set: set }, { upsert: true, new: true })
        .lean();
      return this.countView(doc, weekOf, company);
    } catch (e: any) {
      // El upsert choca con el índice único cuando la toma existe y el bloque está cerrado.
      if (e?.code === 11000) throw badRequest("Este bloque ya está cerrado y no se puede editar.");
      throw e;
    }
  }

  /** Cierra un bloque de la semana: ya no se puede editar. */
  async closeBlock(blockRaw: unknown, body: any, user: string) {
    const company = companyOf(body?.company);
    const block = blockOf(blockRaw);
    const weekOf = mondayOf(todayStr());
    const current = (await models.inventoryCounts.findOne({ company, weekOf }).lean()) as any;
    if (!current?.[block]?.items?.length) throw badRequest("No hay nada contado en este bloque todavía.");
    if (current[block].status === "closed") return this.countView(current, weekOf, company);
    const doc = await models.inventoryCounts
      .findOneAndUpdate(
        { company, weekOf },
        { $set: { [`${block}.status`]: "closed", [`${block}.closedAt`]: new Date(), [`${block}.closedBy`]: user } },
        { new: true }
      )
      .lean();
    return this.countView(doc, weekOf, company);
  }

  /** Registra un utensilio nuevo con su foto (obligatoria). */
  async createUtensil(body: any, user: string) {
    const company = companyOf(body?.company);
    const name = nameOf(body?.name, "el utensilio");
    const photo = body?.photo;
    if (typeof photo !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) {
      throw badRequest("Falta la foto del utensilio.");
    }
    if (photo.length > INVENTORY_RULES.maxPhotoChars) throw badRequest("La foto es demasiado grande. Tómala de nuevo.");

    const nameKey = keyOf(name);
    const existing = (await models.inventoryUtensils.findOne({ company, nameKey }).lean()) as any;
    if (existing?.active) throw badRequest(`Ya existe un utensilio llamado "${existing.name}".`);
    const doc = existing
      ? await models.inventoryUtensils.findByIdAndUpdate(
          existing._id,
          { $set: { name, photo, active: true, createdBy: user } },
          { new: true }
        )
      : await models.inventoryUtensils.create({ company, name, nameKey, photo, createdBy: user });
    return { id: String(doc!._id), name: doc!.name, photo: doc!.photo };
  }
}

export const inventoryService = new InventoryService();
