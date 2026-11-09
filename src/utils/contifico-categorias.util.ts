import { ContificoService } from "../services/contifico.service";
import { normalizeString } from "./string.utils";

/** Nombres de la app que en Contífico se llaman distinto (confirmado por Gerencia, 09/11/2026). */
const NOMBRES_APP_CONTIFICO: Array<[string, string]> = [
  ["Tarta de Queso porcion", "Tarta de Queso al Estilo Vasco"],
  ["Cuatro Leches porcion", "4 Leches porcion"],
  ["Cookies Avena x3", "Galletas de Avena (x3)"],
  ["Cookies Chocochip x3", "Galletas Chocochip (x3)"],
  ["Mini Tarta Tiramisu", "Mini Vasca de Tiramisú"],
];

export interface CategoryMaps {
  byId: Map<string, string>;
  byName: Map<string, string>;
  codeByName: Map<string, string>; // código de Contífico por nombre normalizado
}

/**
 * Categoría de cada producto, tal cual Contífico, usando como fuente de verdad
 * SOLO las subcategorías de "Producto Venta" (padre_id = esa categoría).
 * Un producto cuya categoría no cuelga de "Producto Venta" queda sin mapear
 * (los consumidores lo agrupan en "Otros"). Si la cuenta no tiene "Producto
 * Venta" (ej. Sucree), se usan todas sus categorías.
 *
 * Mapea por id de producto y por nombre normalizado: los ids guardados en
 * configuraciones viejas pueden ya no existir en Contífico, pero el nombre
 * sí calza. Usa el caché de ContificoService (TTL 1h); ante un error devuelve
 * mapas vacíos y nada se rompe.
 */
export async function buildContificoCategoryMaps(svc: ContificoService): Promise<CategoryMaps> {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  const codeByName = new Map<string, string>();
  try {
    const [products, categories] = await Promise.all([
      svc.getCachedProducts(),
      svc.getCachedCategories(),
    ]);

    const productoVenta = (categories || []).find(
      (c: any) => normalizeString(c.nombre || "") === "producto venta"
    );

    const validas = productoVenta
      ? (categories || []).filter((c: any) => c.padre_id === productoVenta.id)
      : (categories || []);

    const catName = new Map<string, string>(
      validas.map((c: any) => [
        c.id,
        // "Cakes Porcion." → "Cakes Porcion" (los hijos vienen con punto final)
        String(c.nombre || "").trim().replace(/\.+$/, ""),
      ])
    );

    for (const p of products || []) {
      const nombre = p.categoria_id ? catName.get(p.categoria_id) : undefined;
      if (!nombre) continue;
      if (p.id) byId.set(p.id, nombre);
      if (p.nombre) byName.set(normalizeString(p.nombre), nombre);
      if (p.nombre && p.codigo) codeByName.set(normalizeString(p.nombre), p.codigo);
    }

    for (const [nombreApp, nombreContifico] of NOMBRES_APP_CONTIFICO) {
      const categoria = byName.get(normalizeString(nombreContifico));
      const codigo = codeByName.get(normalizeString(nombreContifico));
      if (categoria) byName.set(normalizeString(nombreApp), categoria);
      if (codigo) codeByName.set(normalizeString(nombreApp), codigo);
    }
  } catch (err: any) {
    console.warn(`⚠️ [${svc.source}] No se pudieron leer las categorías de Contífico: ${err?.message || err}`);
  }
  return { byId, byName, codeByName };
}
