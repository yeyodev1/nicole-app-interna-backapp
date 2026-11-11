import { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { productionEntryService } from "../services/production-entry.service";

/** Tablet de planta: usuario de producción (y administradores para soporte). */
const TABLET_ROLES = ["PRODUCTION", "OPERATIONS_MANAGER", "SUPERADMIN", "ADMIN"];
/** Histórico, fichas y lista de operarios: solo el Jefe de Operaciones (y administradores). */
const MANAGER_ROLES = ["OPERATIONS_MANAGER", "SUPERADMIN", "ADMIN"];

const roleOf = (req: Request) => String((req as any).user?.role || "").toUpperCase();
const userOf = (req: Request) => (req as any).user?.name || (req as any).user?.email || "app";

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

/** GET /api/production-entries/tablet */
export async function getTabletData(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, TABLET_ROLES, "Solo la tablet de producción puede registrar ingresos.")) return;
  try {
    const data = await productionEntryService.getTabletData();
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar el ingreso de producción.");
  }
}

/** POST /api/production-entries  { operatorId, company, area, items: [{ code, quantity }], photo } */
export async function createProductionEntry(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, TABLET_ROLES, "Solo la tablet de producción puede registrar ingresos.")) return;
  try {
    const data = await productionEntryService.createEntry(req.body, userOf(req));
    res.status(HttpStatusCode.Created).send({ message: "Ingreso guardado.", data });
  } catch (error) {
    fail(res, error, "No se pudo guardar el ingreso.");
  }
}

/** GET /api/production-entries/history?month=AAAA-MM */
export async function getProductionHistory(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, MANAGER_ROLES, "Solo el Jefe de Operaciones puede ver el histórico.")) return;
  try {
    const data = await productionEntryService.getHistory(String(req.query.month || ""));
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar el histórico de producción.");
  }
}

/** GET /api/production-entries/operators */
export async function listProductionOperators(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, MANAGER_ROLES, "Solo el Jefe de Operaciones puede ver los operarios.")) return;
  try {
    const data = await productionEntryService.listOperators();
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar la lista de operarios.");
  }
}

/** POST /api/production-entries/operators  { name } */
export async function addProductionOperator(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, MANAGER_ROLES, "Solo el Jefe de Operaciones puede agregar operarios.")) return;
  try {
    const data = await productionEntryService.addOperator(req.body?.name, userOf(req));
    res.status(HttpStatusCode.Created).send({ message: `${data.name} ya aparece en la tablet.`, data });
  } catch (error) {
    fail(res, error, "No se pudo agregar el operario.");
  }
}

/** DELETE /api/production-entries/operators/:id  (lo saca de la tablet; su historial se conserva) */
export async function removeProductionOperator(req: Request, res: Response): Promise<void> {
  if (!guard(req, res, MANAGER_ROLES, "Solo el Jefe de Operaciones puede borrar operarios.")) return;
  try {
    const data = await productionEntryService.removeOperator(String(req.params.id), userOf(req));
    res.status(HttpStatusCode.Ok).send({ message: `${data.name} ya no aparece en la tablet. Su historial sigue guardado.`, data });
  } catch (error) {
    fail(res, error, "No se pudo borrar el operario.");
  }
}
