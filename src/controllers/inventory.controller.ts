import { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { inventoryService } from "../services/inventory.service";
import { INVENTORY_COUNT_ROLES, INVENTORY_SETTINGS_ROLES } from "../config/inventory.config";

const roleOf = (req: Request) => String((req as any).user?.role || "").toUpperCase();
const userOf = (req: Request) => (req as any).user?.name || (req as any).user?.email || "app";

const COUNT_DENIED = "Solo Producción y el Jefe de Operaciones pueden tomar el inventario.";
const SETTINGS_DENIED = "Solo el Jefe de Operaciones puede cambiar los ajustes del inventario.";

function guard(req: Request, res: Response, roles: string[], message: string): boolean {
  if (roles.includes(roleOf(req))) return true;
  res.status(HttpStatusCode.Forbidden).send({ message });
  return false;
}

function fail(res: Response, error: any, fallback: string) {
  if (error?.status === 400) {
    res.status(HttpStatusCode.BadRequest).send({ message: error.message });
    return;
  }
  console.error(fallback, error);
  res.status(HttpStatusCode.InternalServerError).send({ message: fallback });
}

/** GET /api/inventory/catalog?company=nicole */
export async function getInventoryCatalog(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, INVENTORY_COUNT_ROLES, COUNT_DENIED)) return;
  try {
    const data = await inventoryService.getCatalog(req.query.company);
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar el catálogo del inventario.");
  }
}

/** PUT /api/inventory/catalog  { company, blocks, units } */
export async function saveInventoryCatalog(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, INVENTORY_SETTINGS_ROLES, SETTINGS_DENIED)) return;
  try {
    const data = await inventoryService.saveCatalog(req.body, userOf(req));
    res.status(HttpStatusCode.Ok).send({ message: "Ajustes guardados.", data });
  } catch (error) {
    fail(res, error, "No se pudieron guardar los ajustes del inventario.");
  }
}

/** GET /api/inventory/week?company=nicole */
export async function getInventoryWeek(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, INVENTORY_COUNT_ROLES, COUNT_DENIED)) return;
  try {
    const data = await inventoryService.getWeek(req.query.company);
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar la toma de inventario.");
  }
}

/** PUT /api/inventory/week/blocks/:block  { company, items, responsible } */
export async function saveInventoryBlock(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, INVENTORY_COUNT_ROLES, COUNT_DENIED)) return;
  try {
    const data = await inventoryService.saveBlock(req.params.block, req.body, userOf(req));
    res.status(HttpStatusCode.Ok).send({ message: "Guardado.", data });
  } catch (error) {
    fail(res, error, "No se pudo guardar el conteo.");
  }
}

/** POST /api/inventory/week/blocks/:block/close  { company } */
export async function closeInventoryBlock(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, INVENTORY_COUNT_ROLES, COUNT_DENIED)) return;
  try {
    const data = await inventoryService.closeBlock(req.params.block, req.body, userOf(req));
    res.status(HttpStatusCode.Ok).send({ message: "Bloque cerrado.", data });
  } catch (error) {
    fail(res, error, "No se pudo cerrar el bloque.");
  }
}

/** POST /api/inventory/utensils  { company, name, photo } */
export async function createInventoryUtensil(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, INVENTORY_COUNT_ROLES, COUNT_DENIED)) return;
  try {
    const data = await inventoryService.createUtensil(req.body, userOf(req));
    res.status(HttpStatusCode.Created).send({ message: "Utensilio agregado.", data });
  } catch (error) {
    fail(res, error, "No se pudo agregar el utensilio.");
  }
}
