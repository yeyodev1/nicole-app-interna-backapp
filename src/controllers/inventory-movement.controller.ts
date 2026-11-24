import { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { inventoryMovementService } from "../services/inventory-movement.service";
import { INVENTORY_COUNT_ROLES } from "../config/inventory.config";

// Movimiento de inventario (solo lectura): lo ven Producción y el Jefe de Operaciones, igual que la toma.
const roleOf = (req: Request) => String((req as any).user?.role || "").toUpperCase();
const DENIED = "Solo Producción y el Jefe de Operaciones pueden ver el movimiento de inventario.";

function allowed(req: Request, res: Response): boolean {
  if (INVENTORY_COUNT_ROLES.includes(roleOf(req))) return true;
  res.status(HttpStatusCode.Forbidden).send({ message: DENIED });
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

/** GET /api/inventory/movement/periods?company=nicole */
export async function getInventoryMovementPeriods(req: Request, res: Response): Promise<void> {
  if (!allowed(req, res)) return;
  try {
    const data = await inventoryMovementService.getPeriods(req.query.company);
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudieron cargar las semanas del inventario.");
  }
}

/** GET /api/inventory/movement?company=nicole&from=AAAA-MM-DD (sin from: la semana abierta) */
export async function getInventoryMovement(req: Request, res: Response): Promise<void> {
  if (!allowed(req, res)) return;
  try {
    const data = await inventoryMovementService.getMovement(req.query.company, req.query.from);
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar el movimiento de inventario.");
  }
}
