import { ContificoService } from "../services/contifico.service";
import { normalizeString } from "./string.utils";

export interface CategoryMaps {
  byId: Map<string, string>;
  byName: Map<string, string>;
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
    }
  } catch (err: any) {
    console.warn(`⚠️ [${svc.source}] No se pudieron leer las categorías de Contífico: ${err?.message || err}`);
  }
  return { byId, byName };
}
