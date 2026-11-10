import { ContificoService } from "../services/contifico.service";
import { ProductAliasModel } from "../models/product-alias.model";
import { normalizeString } from "./string.utils";

export interface CategoryMaps {
  byId: Map<string, string>;
  byName: Map<string, string>;
  codeByName: Map<string, string>; // código de Contífico por nombre normalizado (Contífico o alias)
  codeById: Map<string, string>; // código por contificoId
  nameByCode: Map<string, string>; // nombre oficial de Contífico por código
}

export interface ResolvedProduct {
  codigo: string | null;
  contificoId: string | null;
  nombre: string; // nombre de Contífico; sin código, el nombre tal cual
  categoria: string | null;
  sinCodigo: boolean; // "Sin código Contífico"
}

/**
 * Orden 8: producto identificado por su código de Contífico.
 * Primero por contificoId, luego por nombre de Contífico, luego por alias (productAliases).
 * Si no encuentra, devuelve el nombre tal cual marcado sinCodigo.
 */
export function resolveProduct(maps: CategoryMaps, name: string, contificoId?: string | null): ResolvedProduct {
  const codigo = (contificoId && maps.codeById.get(contificoId)) || maps.codeByName.get(normalizeString(name || "")) || null;
  if (!codigo) {
    return {
      codigo: null,
      contificoId: contificoId || null,
      nombre: String(name || "").trim(),
      categoria: (contificoId && maps.byId.get(contificoId)) || maps.byName.get(normalizeString(name || "")) || null,
      sinCodigo: true,
    };
  }
  const nombre = maps.nameByCode.get(codigo) || String(name || "").trim();
  let id: string | null = contificoId || null;
  if (!id) for (const [k, c] of maps.codeById) if (c === codigo) { id = k; break; }
  return { codigo, contificoId: id, nombre, categoria: maps.byName.get(normalizeString(nombre)) || null, sinCodigo: false };
}

/**
 * Categoría de cada producto, tal cual Contífico, usando como fuente de verdad
 * SOLO las subcategorías de "Producto Venta" (padre_id = esa categoría).
 * Un producto cuya categoría no cuelga de "Producto Venta" queda sin categoría
 * (los consumidores lo agrupan en "Otros"). Si la cuenta no tiene "Producto
 * Venta" (ej. Sucree), se usan todas sus categorías.
 *
 * Códigos y nombres oficiales: de todos los productos de Contífico, más los
 * alias de productAliases (Orden 8; reemplaza la lista fija NOMBRES_APP_CONTIFICO).
 * Usa el caché de ContificoService (TTL 1h); ante un error devuelve
 * mapas vacíos y nada se rompe.
 */
export async function buildContificoCategoryMaps(svc: ContificoService): Promise<CategoryMaps> {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  const codeByName = new Map<string, string>();
  const codeById = new Map<string, string>();
  const nameByCode = new Map<string, string>();
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
      if (p.codigo && p.nombre) {
        nameByCode.set(p.codigo, String(p.nombre).trim());
        codeByName.set(normalizeString(p.nombre), p.codigo);
        if (p.id) codeById.set(p.id, p.codigo);
      }
      const nombre = p.categoria_id ? catName.get(p.categoria_id) : undefined;
      if (!nombre) continue;
      if (p.id) byId.set(p.id, nombre);
      if (p.nombre) byName.set(normalizeString(p.nombre), nombre);
    }

    // Alias de la app → código (solo de esta cuenta: el código debe existir en ella)
    const aliases = (await ProductAliasModel.find().lean()) as any[];
    for (const a of aliases) {
      const nombreContifico = nameByCode.get(a.codigo);
      if (!nombreContifico) continue;
      codeByName.set(a.alias, a.codigo);
      const categoria = byName.get(normalizeString(nombreContifico));
      if (categoria) byName.set(a.alias, categoria);
    }
  } catch (err: any) {
    console.warn(`⚠️ [${svc.source}] No se pudieron leer las categorías de Contífico: ${err?.message || err}`);
  }
  return { byId, byName, codeByName, codeById, nameByCode };
}
