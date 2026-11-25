import { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { inventoryMovementService } from "../services/inventory-movement.service";
import { INVENTORY_COUNT_ROLES, INVENTORY_COMPANIES } from "../config/inventory.config";
import { models } from "../models";
import { normalizeString } from "../utils/string.utils";

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
    const data: any = await inventoryMovementService.getMovement(req.query.company, req.query.from);
    // Comentarios del periodo (toma que lo abre), por código de producto tal cual el catálogo.
    if (!data.empty) {
      const notes = await models.inventoryMovementNotes.find({ company: data.company, from: data.from }).lean();
      data.notes = Object.fromEntries(
        (notes as any[]).map((n) => [n.code, { code: n.code, comment: n.comment, updatedBy: n.updatedBy, updatedAt: n.updatedAt }])
      );
    }
    res.status(HttpStatusCode.Ok).send({ data });
  } catch (error) {
    fail(res, error, "No se pudo cargar el movimiento de inventario.");
  }
}

/**
 * PUT /api/inventory/movement/notes  Body: { company, from, code, name, comment }
 * Guarda el comentario de un producto en el periodo (upsert: editar no duplica). Comentario vacío = se borra.
 */
export async function saveInventoryMovementNote(req: Request, res: Response): Promise<void> {
  if (!allowed(req, res)) return;
  try {
    const b = req.body || {};
    const company = String(b.company || "").toLowerCase();
    const from = String(b.from || "");
    const code = String(b.code || "").trim().slice(0, 30);
    const name = String(b.name || "").trim().slice(0, 120) || code;
    const comment = String(b.comment ?? "").trim();
    if (!INVENTORY_COMPANIES.includes(company as any) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !code) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Faltan empresa, periodo (AAAA-MM-DD) o código del producto." });
      return;
    }
    if (comment.length > 500) {
      res.status(HttpStatusCode.BadRequest).send({ message: "El comentario admite máximo 500 caracteres." });
      return;
    }
    const codeKey = normalizeString(code);
    if (!comment) {
      await models.inventoryMovementNotes.deleteOne({ company, from, codeKey });
      res.status(HttpStatusCode.Ok).send({ message: "Comentario borrado.", data: null });
      return;
    }
    const user = (req as any).user?.name || (req as any).user?.email || "Operaciones";
    const saved: any = await models.inventoryMovementNotes
      .findOneAndUpdate(
        { company, from, codeKey },
        { $set: { code, name, comment, updatedBy: user }, $setOnInsert: { company, from, codeKey, createdBy: user } },
        { upsert: true, new: true, runValidators: true }
      )
      .lean();
    res.status(HttpStatusCode.Ok).send({
      message: "Comentario guardado.",
      data: { code: saved.code, comment: saved.comment, updatedBy: saved.updatedBy, updatedAt: saved.updatedAt },
    });
  } catch (error) {
    fail(res, error, "No se pudo guardar el comentario.");
  }
}
