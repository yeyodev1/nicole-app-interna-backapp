/**
 * Orden 8 (10/11/2026): carga inicial de productAliases (nombre en la app → código de Contífico de Nicole).
 * Tabla aprobada por Mauro (Paso 2) + los 5 pares que tenía NOMBRES_APP_CONTIFICO.
 * Idempotente: upsert por alias normalizado. `--dry-run` solo informa.
 * Uso: ./node_modules/.bin/ts-node-dev --transpile-only scripts/seed-product-aliases.ts [--dry-run]
 */
import * as dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { ProductAliasModel } from "../src/models/product-alias.model";
import { ContificoService } from "../src/services/contifico.service";
import { normalizeString } from "../src/utils/string.utils";

const ALIASES: Array<[string, string[]]> = [
  ["CAKP-006", ["Cuatro Leches porcion"]],
  ["CAKP-010", ["Tarta de Queso porcion"]],
  ["IND-020", ["Galletas de Avena x3", "Cookies Avena x3"]],
  ["IND-021", ["Galletas Chocochip x3", "Cookies Chocochip x3"]],
  ["IND-022", ["Mini Tarta Pistacho", "Mini Vasca Pistacho"]],
  ["IND-023", ["Mini Tarta Tiramisu", "Mini Vasca Tiramisú"]],
  ["IND-024", ["Mini Vasca Chocolate"]],
  ["IND-025", ["Mini Tarta Brie"]],
  ["IND-026", ["Mini Tarta Limon y Arandanos", "Mini Vasca Limón y Arándanos", "Mini tarta vasca limon y arandanos"]],
  ["IND-030", ["CANASTA DE FRUTAS"]],
  ["TOS-003", ["Croissant Jamón y Queso"]],
  ["PAN-012", ["Rosca clásica con crema pastelera"]],
];

(async () => {
  const dry = process.argv.includes("--dry-run");
  await mongoose.connect(process.env.DB_URI as string);
  const products = (await new ContificoService("nicole").getCachedProducts()) as any[];
  const byCode = new Map(products.filter((p) => p.codigo).map((p) => [p.codigo, p]));
  let ok = 0;
  for (const [codigo, names] of ALIASES) {
    const p: any = byCode.get(codigo);
    if (!p) { console.log(`✗ ${codigo} no existe en Contífico: se omite`); continue; }
    for (const aliasName of names) {
      const alias = normalizeString(aliasName);
      if (alias === normalizeString(p.nombre)) { console.log(`= ${aliasName} ya es el nombre de Contífico`); continue; }
      console.log(`${dry ? "·" : "✓"} ${aliasName} → ${codigo} ${p.nombre}`);
      if (!dry) {
        await ProductAliasModel.updateOne(
          { alias },
          { $set: { alias, aliasName, codigo, contificoId: p.id, updatedBy: "Orden 8 (carga inicial)" }, $setOnInsert: { createdBy: "Orden 8 (carga inicial)" } },
          { upsert: true }
        );
      }
      ok++;
    }
  }
  console.log(`${ok} alias ${dry ? "por cargar" : "cargados"}.`);
  await mongoose.disconnect();
  process.exit(0);
})();
