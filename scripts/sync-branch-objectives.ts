/**
 * Pone al día los productos del cierre de las sucursales (posstockobjectives).
 *
 * 1. Reenlaza cada producto con su id ACTUAL de Contífico. Contífico recreó el
 *    catálogo (productos con fecha 25/09/2026) y ningún `contificoId` guardado
 *    existía ya: la venta solo cruzaba por nombre y todo lo que se llama
 *    distinto en Contífico (ej. "Mini Tarta Brie" = "Mini tarta vasca brie")
 *    salía en 0 en el cierre y en el reporte de operaciones.
 * 2. San Marino queda con EXACTAMENTE los mismos productos que Mall del Sol
 *    (mismo nombre, tipo y categoría). Lo que San Marino tenía con otro nombre
 *    se renombra (también en su historial de cierres y bajas, para no perder el
 *    stock inicial); lo que le faltaba se crea con los mínimos de Mall del Sol.
 *    Lo propio de San Marino (helados, salsas, brioches…) se queda.
 * 3. Unifica la sucursal "Mall del sol" → "Mall del Sol".
 *
 * Uso:
 *   pnpm sync:objectives              → dry-run (solo muestra los cambios)
 *   pnpm sync:objectives -- --confirm → aplica
 */
import "dotenv/config";
import mongoose from "mongoose";
import { ContificoService } from "../src/services/contifico.service";
import { normalizeString } from "../src/utils/string.utils";

const MASTER = "Mall del Sol";
const MIRROR = "San Marino";

// Nombre del cierre → nombre en Contífico, cuando no son iguales.
const CONTIFICO_ALIASES: Record<string, string> = {
  "mini tarta brie": "mini tarta vasca brie",
  "mini tarta limon y arandanos": "mini tarta vasca limon y arandanos",
  "mini tarta pistacho": "mini tarta vasca pistacho",
  "mini tarta tiramisu": "mini tarta vasca tiramisu",
  "mini vasca chocolate": "mini tarta vasca chocolate",
  "croissant jamon y queso": "croissant de jamon & queso",
};

// Nombre en San Marino → nombre en Mall del Sol (mismo producto).
const MIRROR_ALIASES: Record<string, string> = {
  "mini tarta de milo": "Mini Tarta Milo",
  "mini tarta de tiramisu": "Mini Tarta Tiramisu",
  "mini tarta creem brulee": "Mini Tarta Creme Brulee",
  "parisino vasco": "Parisino Vasco",
  "sirope chocolate baristas": "Sirope de Chocolate BARISTA",
  "sirope vainilla barista": "Sirope de Vainilla BARISTA",
  "chocolate caliente": "Chocolate Caliente BARISTA",
};

async function fetchCatalog(): Promise<any[]> {
  const contifico = new ContificoService("nicole");
  const all: any[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const res: any[] = (await contifico.getProducts({ result_size: 200, result_page: page })) || [];
    let nuevos = 0;
    for (const p of res) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      all.push(p);
      nuevos++;
    }
    if (res.length < 200 || nuevos === 0) break;
  }
  return all;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  if (!process.env.DB_URI) throw new Error("Falta DB_URI en el .env");
  await mongoose.connect(process.env.DB_URI);
  const db = mongoose.connection;
  const objectivesCol = db.collection("posstockobjectives");
  const entriesCol = db.collection("posdailyentries");
  const lossesCol = db.collection("poslosses");

  const catalog = await fetchCatalog();
  console.log(`Catálogo Contífico: ${catalog.length} productos`);
  // Activos primero: si hay un activo y uno inactivo con el mismo nombre, gana el activo.
  const byName = new Map<string, any>();
  for (const p of [...catalog].sort((a, b) => (a.estado === "A" ? 1 : 0) - (b.estado === "A" ? 1 : 0))) {
    byName.set(normalizeString(p.nombre), p);
  }
  const findInCatalog = (name: string) => {
    const key = normalizeString(name);
    return byName.get(CONTIFICO_ALIASES[key] || key) || null;
  };

  const ops: Array<{ label: string; run: () => Promise<unknown> }> = [];

  // --- 3. "Mall del sol" → "Mall del Sol" ---
  const badCase = await objectivesCol.find({ branch: "Mall del sol" }).toArray();
  for (const o of badCase) {
    ops.push({
      label: `Sucursal "Mall del sol" → "${MASTER}": ${o.productName}`,
      run: () => objectivesCol.updateOne({ _id: o._id }, { $set: { branch: MASTER } }),
    });
  }

  // --- 2. San Marino = Mall del Sol ---
  const master = await objectivesCol.find({ branch: { $in: [MASTER, "Mall del sol"] } }).toArray();
  const mirror = await objectivesCol.find({ branch: MIRROR }).toArray();
  const mirrorByKey = new Map(mirror.map((o) => [normalizeString(o.productName), o]));

  for (const m of master) {
    const key = normalizeString(m.productName);
    let current = mirrorByKey.get(key);
    if (!current) {
      const aliasKey = Object.keys(MIRROR_ALIASES).find(
        (k) => normalizeString(MIRROR_ALIASES[k]) === key && mirrorByKey.has(k)
      );
      if (aliasKey) current = mirrorByKey.get(aliasKey);
    }

    const shape = {
      productName: m.productName,
      unit: m.unit || "unidad",
      isGeneral: !!m.isGeneral,
      requiresMinimum: !!m.requiresMinimum,
      category: m.category || "Producción",
    };

    if (!current) {
      ops.push({
        label: `${MIRROR}: + ${m.productName} (nuevo, mínimos de ${MASTER})`,
        run: () => objectivesCol.insertOne({ branch: MIRROR, ...shape, contificoId: findInCatalog(m.productName)?.id ?? m.contificoId, objectives: m.objectives, createdAt: new Date(), updatedAt: new Date() }),
      });
      continue;
    }

    const oldName = current.productName;
    // Campos sin guardar valen lo mismo que su default del esquema.
    const DEFAULTS: Record<string, unknown> = { unit: "unidad", isGeneral: false, requiresMinimum: false, category: "Producción" };
    const changes = Object.entries(shape).filter(([k, v]) => ((current as any)[k] ?? DEFAULTS[k]) !== v);
    if (changes.length === 0) continue;
    ops.push({
      label: `${MIRROR}: ${oldName} → ${changes.map(([k, v]) => `${k}=${v}`).join(", ")}`,
      run: async () => {
        await objectivesCol.updateOne({ _id: current!._id }, { $set: { ...shape, updatedAt: new Date() } });
        if (oldName !== m.productName) {
          await entriesCol.updateMany(
            { branch: MIRROR, "items.productName": oldName },
            { $set: { "items.$[it].productName": m.productName } },
            { arrayFilters: [{ "it.productName": oldName }] }
          );
          await lossesCol.updateMany({ branch: MIRROR, productName: oldName }, { $set: { productName: m.productName } });
        }
      },
    });
  }

  // --- 1. Reenlazar con Contífico (todas las sucursales, después del espejo) ---
  const relinkTargets = await objectivesCol.find({}).toArray();
  const pendingNames = new Set<string>();
  // En San Marino se busca por el nombre que tendrá tras el espejo.
  const finalName = (o: any) =>
    (o.branch === MIRROR && MIRROR_ALIASES[normalizeString(o.productName)]) || o.productName;
  for (const o of relinkTargets) {
    const p = findInCatalog(finalName(o));
    if (!p) {
      if (!o.isGeneral) pendingNames.add(`${o.branch} · ${o.productName}`);
      continue;
    }
    if (o.contificoId === p.id) continue;
    ops.push({
      label: `${o.branch}: ${o.productName} → "${p.nombre}" [${p.id}]${p.estado !== "A" ? " (inactivo en Contífico)" : ""}`,
      run: () => objectivesCol.updateOne({ _id: o._id }, { $set: { contificoId: p.id } }),
    });
  }

  for (const op of ops) console.log(" •", op.label);
  if (pendingNames.size) {
    console.log("\nSin producto en Contífico (la venta seguirá en 0):");
    for (const n of pendingNames) console.log("   -", n);
  }

  if (!confirm) {
    console.log(`\nDry-run: ${ops.length} cambios, no se aplicó nada. Ejecuta con -- --confirm.`);
  } else {
    for (const op of ops) await op.run();
    console.log(`\n✅ ${ops.length} cambios aplicados.`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
