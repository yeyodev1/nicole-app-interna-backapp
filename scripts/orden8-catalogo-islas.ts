/**
 * Orden 8 · Paso 3 (10/11/2026): catálogo de cada isla (posStockObjectives) por código de Contífico.
 * - Sucursal con su nombre oficial de branches ("Mall del sol" → "Mall del Sol").
 * - contificoId y nombre de Contífico en cada producto con código.
 * - Duplicados de una misma isla (mismo código) se unen: queda el que tiene objetivos (no se suman).
 * - CANASTA DE FRUTAS de Mall del Sol pasa a IND-030 con isGeneral = false.
 * - Índice único sucursal + contificoId.
 * Los cierres, pedidos y despachos guardados no se tocan. `--dry-run` solo informa.
 * Uso: ./node_modules/.bin/ts-node-dev --transpile-only scripts/orden8-catalogo-islas.ts [--dry-run]
 */
import * as dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { models } from "../src/models";
import { ContificoService } from "../src/services/contifico.service";
import { buildContificoCategoryMaps, resolveProduct } from "../src/utils/contifico-categorias.util";
import { normalizeString } from "../src/utils/string.utils";

const sumObj = (o: any) => Object.values(o.objectives || {}).reduce((s: number, v: any) => s + (Number(v) || 0), 0);

(async () => {
  const dry = process.argv.includes("--dry-run");
  await mongoose.connect(process.env.DB_URI as string);
  const maps = await buildContificoCategoryMaps(new ContificoService("nicole"));
  if (maps.nameByCode.size === 0) throw new Error("Contífico no respondió: no se cambia nada.");
  const branches = (await models.branches.find().lean()) as any[];
  const official = (b: string) => branches.find((x) => normalizeString(x.name) === normalizeString(b))?.name || b;
  const objs = (await models.posStockObjectives.find().lean()) as any[];

  const groups = new Map<string, any[]>();
  for (const o of objs) {
    if (normalizeString(o.productName) === "canasta de frutas") o.isGeneral = false;
    const r = resolveProduct(maps, o.productName, o.contificoId);
    o._r = r;
    o._branch = official(o.branch);
    const k = `${normalizeString(o._branch)}|${r.codigo ? "#" + r.codigo : normalizeString(o.productName)}`;
    groups.set(k, [...(groups.get(k) || []), o]);
  }

  const deletes: any[] = [];
  const updates: Array<{ _id: any; set: any; desc: string }> = [];
  for (const list of groups.values()) {
    list.sort((a, b) => sumObj(b) - sumObj(a) || Number(normalizeString(b.productName) === normalizeString(b._r.nombre)) - Number(normalizeString(a.productName) === normalizeString(a._r.nombre)));
    const [keep, ...rest] = list;
    for (const d of rest) {
      deletes.push(d._id);
      console.log(`✗ unir: borrar ${d.branch} | ${d.productName} (objetivos ${sumObj(d)}) → queda ${keep.productName} (objetivos ${sumObj(keep)})`);
    }
    const set: any = {};
    if (keep.branch !== keep._branch) set.branch = keep._branch;
    // Solo se renombra si el nombre viejo resuelve al mismo código (por nombre o alias): si no, los
    // cierres guardados con el nombre viejo dejarían de enlazar (ej. Tartaleta Frutos rojos Entera → Fraisier).
    const byNameCode = maps.codeByName.get(normalizeString(keep.productName));
    if (!keep._r.sinCodigo) {
      if (keep.productName !== keep._r.nombre && byNameCode === keep._r.codigo) set.productName = keep._r.nombre;
      if (keep._r.contificoId && keep.contificoId !== keep._r.contificoId) set.contificoId = keep._r.contificoId;
    }
    if (normalizeString(keep.productName) === "canasta de frutas") set.isGeneral = false;
    if (Object.keys(set).length) {
      updates.push({ _id: keep._id, set, desc: `${keep.branch} | ${keep.productName} → ${JSON.stringify(set)}` });
    }
  }
  for (const u of updates) console.log("✓", u.desc);
  console.log(`${deletes.length} duplicados a unir, ${updates.length} productos a actualizar, ${objs.length} en total.`);

  if (!dry) {
    // Solo se borran los duplicados aprobados (Mall del Sol, objetivos en 0), por _id exacto
    const APROBADOS = ["6ae9626fc31082449ff927b5", "6aea9f82c31082449ff93b70"];
    const ids = deletes.map(String);
    if (ids.some((id) => !APROBADOS.includes(id))) throw new Error(`Duplicados no aprobados: ${ids.join(", ")}`);
    for (const id of ids) await models.posStockObjectives.deleteOne({ _id: id });
    for (const u of updates) await models.posStockObjectives.updateOne({ _id: u._id }, { $set: u.set });
    await models.posStockObjectives.syncIndexes();
    console.log("Índices:", (await models.posStockObjectives.collection.indexes()).map((i: any) => i.name).join(", "));
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
