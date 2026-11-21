import { models } from "../models";

/**
 * Empresa (contabilidad / cuenta Contífico) de cada sucursal.
 *
 * Pedido de Operaciones (Mauro, 21/11/2026): los locales de Sucrée (Sucrenda SAS),
 * empezando por Entre Ríos, funcionan como una sucursal más: cierre y pedido de
 * reposición desde Gestión de Sucursal, mismo despacho del CDP. Para separar luego
 * la contabilidad por razón social, cada sucursal guarda a qué empresa pertenece.
 *
 * Usa los mismos valores que `Order.contificoSource`: "nicole" = La Finestra,
 * "sucree" = Sucrenda. Una sucursal sin el campo (datos viejos) es de "nicole".
 */
export type BranchCompany = "nicole" | "sucree";
export const BRANCH_COMPANIES: BranchCompany[] = ["nicole", "sucree"];

/** Marca con la que se carga el gasto en el requerimiento a Bodega (InternalRequisition.brand). */
export const REQUISITION_BRAND: Record<BranchCompany, string> = {
  nicole: "Nicole",
  sucree: "Sucree",
};

/** Roles que pueden crear, editar y desactivar sucursales (Puntos de Venta). */
export const BRANCH_SETTINGS_ROLES = ["OPERATIONS_MANAGER", "SALES_MANAGER", "SUPERADMIN", "ADMIN"];

export const isCdpBranch = (name: unknown) => /centro|producc/i.test(String(name || ""));

export function exactNameRegex(name: string): RegExp {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`, "i");
}

export function normalizeCompany(value: unknown): BranchCompany | null {
  const v = String(value || "").trim().toLowerCase();
  return (BRANCH_COMPANIES as string[]).includes(v) ? (v as BranchCompany) : null;
}

/** Empresa de la sucursal por nombre (sin distinguir mayúsculas). Sin sucursal o sin campo: "nicole". */
export async function companyOfBranch(name: string): Promise<BranchCompany> {
  if (!name || !name.trim()) return "nicole";
  const branch: any = await models.branches.findOne({ name: exactNameRegex(name) }).lean();
  return normalizeCompany(branch?.company) || "nicole";
}

/**
 * ¿La sucursal ya tiene movimientos guardados con su nombre? Pedidos, despachos,
 * cierres, bajas, objetivos de stock e inventario inicial guardan el nombre como
 * texto: si se renombra o se borra, ese historial queda colgando de un nombre que
 * ya no existe. Con historial no se renombra ni se borra (solo se desactiva).
 */
export async function branchHasHistory(name: string): Promise<boolean> {
  const rx = exactNameRegex(name);
  const checks = [
    models.orders.exists({ branch: rx }),
    models.orders.exists({ "dispatches.destination": rx }),
    models.posDailyEntries.exists({ branch: rx }),
    models.posLosses.exists({ branch: rx }),
    models.posStockObjectives.exists({ branch: rx }),
    models.initialInventories.exists({ branch: rx }),
  ];
  const results = await Promise.all(checks);
  return results.some(Boolean);
}
