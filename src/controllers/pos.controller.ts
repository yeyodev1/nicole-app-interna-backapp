import type { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { POSService } from "../services/pos.service";
import { POSRestockService } from "../services/pos-restock.service";
import { OperationsReportService } from "../services/operations-report.service";
import { getECDateRange, getEcuadorNow } from "../utils/date.utils";

const posService = new POSService();
const posRestockService = new POSRestockService();
const operationsReportService = new OperationsReportService();

/**
 * GET /api/pos/dispatches
 * Query Params: branch (required) - e.g. "San Marino"
 */
export async function getIncomingDispatches(req: Request, res: Response) {
  try {
    const { branch, search, filterMode, date, receptionStatus } = req.query;

    const filters: any = {
      search: search as string,
      receptionStatus: receptionStatus as string | string[]
    };

    // --- Date Calculation Logic ---
    let { startDate, endDate } = getECDateRange(getEcuadorNow().toISOString().split('T')[0], false);

    if (date) {
      const range = getECDateRange(String(date), false);
      startDate = range.startDate;
      endDate = range.endDate;
    } else if (filterMode === 'yesterday') {
      const yesterday = getEcuadorNow();
      yesterday.setDate(yesterday.getDate() - 1);
      const range = getECDateRange(yesterday.toISOString().split('T')[0], false);
      startDate = range.startDate;
      endDate = range.endDate;
    } else if (filterMode === 'tomorrow') {
      const tomorrow = getEcuadorNow();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const range = getECDateRange(tomorrow.toISOString().split('T')[0], false);
      startDate = range.startDate;
      endDate = range.endDate;
    } else if (filterMode === 'all') {
      startDate = new Date(0);
      endDate = new Date(2100, 0, 1);
    }

    filters.startDate = startDate.toISOString();
    filters.endDate = endDate.toISOString();

    const dispatches = await posService.getIncomingDispatches(branch as string, filters);

    res.status(HttpStatusCode.Ok).send({
      message: "Incoming dispatches retrieved successfully.",
      count: dispatches.length,
      data: dispatches
    });
  } catch (error: any) {
    console.error("Error retrieving incoming dispatches:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve dispatches.", error: error.message });
  }
}

/**
 * POST /api/pos/dispatches/:orderId/:dispatchId/confirm
 * Body: { receivedBy, receptionNotes, items: [{ productId, quantityReceived, itemStatus }] }
 */
export async function confirmReception(req: Request, res: Response) {
  try {
    const { orderId, dispatchId } = req.params;
    const { receivedBy, receptionNotes, items } = req.body;

    if (!items || !Array.isArray(items)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Items array is required for reception confirmation." });
      return;
    }

    const result = await posService.registerReception(orderId, dispatchId, {
      receivedBy: receivedBy || "POS Manager",
      receptionNotes,
      items
    });

    res.status(HttpStatusCode.Ok).send({
      message: "Reception confirmed successfully.",
      data: result
    });
  } catch (error: any) {
    console.error("Error confirming reception:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to confirm reception.", error: error.message });
  }
}

/**
 * GET /api/pos/pickups
 * Query Params: branch (required)
 */
export async function getPickupOrders(req: Request, res: Response) {
  try {
    const { branch, search, filterMode, date, receivedOnly } = req.query;

    const filters: any = { search: search as string };

    let { startDate, endDate } = getECDateRange(getEcuadorNow().toISOString().split('T')[0], false);

    if (date) {
      const range = getECDateRange(String(date), false);
      startDate = range.startDate;
      endDate = range.endDate;
    } else if (filterMode === 'yesterday') {
      const yesterday = getEcuadorNow();
      yesterday.setDate(yesterday.getDate() - 1);
      const range = getECDateRange(yesterday.toISOString().split('T')[0], false);
      startDate = range.startDate;
      endDate = range.endDate;
    } else if (filterMode === 'tomorrow') {
      const tomorrow = getEcuadorNow();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const range = getECDateRange(tomorrow.toISOString().split('T')[0], false);
      startDate = range.startDate;
      endDate = range.endDate;
    } else if (filterMode === 'all') {
      startDate = new Date(0);
      endDate = new Date(2100, 0, 1);
    }

    filters.startDate = startDate.toISOString();
    filters.endDate = endDate.toISOString();

    let orders = await posService.getPickupOrders(branch as string, filters);

    // Apply "Received" filter if requested
    if (receivedOnly === "true") {
      orders = orders.filter((o: any) => o.posStatus === "RECEIVED");
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Pickup orders retrieved successfully.",
      count: orders.length,
      data: orders
    });
  } catch (error: any) {
    console.error("Error retrieving pickup orders:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve pickup orders.", error: error.message });
  }
}

/**
 * PUT /api/pos/pickups/:orderId/deliver
 */
export async function deliverPickupOrder(req: Request, res: Response) {
  try {
    const { orderId } = req.params;

    const result = await posService.markAsDelivered(orderId);

    res.status(HttpStatusCode.Ok).send({
      message: "Order marked as delivered successfully.",
      data: result
    });
  } catch (error: any) {
    console.error("Error delivering pickup order:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to mark order as delivered.", error: error.message });
  }
}


/**
 * GET /api/pos/restock/objectives?branch=X
 */
export async function getRestockObjectives(req: Request, res: Response): Promise<void> {
  try {
    const { branch } = req.query;
    if (!branch) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch query param is required." });
      return;
    }
    const data = await posRestockService.getObjectives(branch as string);
    res.status(HttpStatusCode.Ok).send({ message: "Objectives retrieved.", count: data.length, data });
  } catch (error: any) {
    console.error("Error retrieving restock objectives:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve objectives.", error: error.message });
  }
}

/**
 * POST /api/pos/restock/objectives
 * Body: { branch, productName, unit, contificoId?, objectives: { Mon, Tue, Wed, Thu, Fri, Sat, Sun } }
 */
export async function upsertRestockObjective(req: Request, res: Response): Promise<void> {
  try {
    const { branch, productName, unit, contificoId, isGeneral, requiresMinimum, category, objectives } = req.body;
    if (!branch || !productName || !unit || !objectives) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch, productName, unit, and objectives are required." });
      return;
    }
    const data = await posRestockService.upsertObjective({ branch, productName, unit, contificoId, isGeneral, requiresMinimum, category, objectives });
    res.status(HttpStatusCode.Ok).send({ message: "Objective saved.", data });
  } catch (error: any) {
    console.error("Error upserting restock objective:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to save objective.", error: error.message });
  }
}

/**
 * DELETE /api/pos/restock/objectives/:productName?branch=X
 */
export async function deleteRestockObjective(req: Request, res: Response): Promise<void> {
  try {
    const { branch } = req.query;
    const { productName } = req.params;

    if (!branch || !productName) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch query param and productName path param are required." });
      return;
    }

    const deleted = await posRestockService.deleteObjective(branch as string, productName);

    if (deleted) {
      res.status(HttpStatusCode.Ok).send({ message: "Re-stock configuration deleted successfully." });
    } else {
      res.status(HttpStatusCode.NotFound).send({ message: "Configuration not found." });
    }
  } catch (error: any) {
    console.error("Error deleting restock objective:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to delete objective.", error: error.message });
  }
}

/**
 * GET /api/pos/restock/daily-form?branch=X&date=YYYY-MM-DD
 */
export async function getRestockDailyForm(req: Request, res: Response): Promise<void> {
  try {
    const { branch, date } = req.query;
    if (!branch) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch query param is required." });
      return;
    }
    const data = await posRestockService.getDailyForm(branch as string, date as string | undefined);
    res.status(HttpStatusCode.Ok).send({ message: "Daily form retrieved.", data });
  } catch (error: any) {
    console.error("Error retrieving daily form:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve daily form.", error: error.message });
  }
}

/**
 * GET /api/pos/restock/daily-sales?branch=X&date=YYYY-MM-DD
 * Venta del día de la sucursal según Contífico (porciones vendidas por producto).
 * Es lento (~10-15s la primera vez por día): el frontend lo pide aparte del formulario.
 */
export async function getRestockDailySales(req: Request, res: Response): Promise<void> {
  try {
    const { branch, date } = req.query;
    if (!branch) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch query param is required." });
      return;
    }
    const data = await posRestockService.getDailySales(branch as string, date as string | undefined);
    res.status(HttpStatusCode.Ok).send({ message: "Daily sales retrieved.", data });
  } catch (error: any) {
    console.error("Error retrieving daily sales:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve daily sales.", error: error.message });
  }
}

/**
 * GET /api/pos/restock/operations-report?date=YYYY-MM-DD
 * Reporte del Jefe de Operaciones: Contífico vs datos internos por sucursal
 * (vendido, venta según cierre, bajas con motivos y descuadres).
 */
export async function getOperationsReport(req: Request, res: Response): Promise<void> {
  try {
    const date = (req.query.date as string) || new Date(Date.now() - 5 * 3600000).toISOString().split("T")[0];
    const to = req.query.to as string | undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      res.status(HttpStatusCode.BadRequest).send({ message: "date/to deben ser YYYY-MM-DD" });
      return;
    }
    const data = await operationsReportService.getReport(date, to);
    res.status(HttpStatusCode.Ok).send({ message: "Operations report retrieved.", data });
  } catch (error: any) {
    console.error("Error retrieving operations report:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve operations report.", error: error.message });
  }
}

/**
 * POST /api/pos/restock/daily-entry
 * Body: { branch, date, submittedBy, items: [{ productName, bajas, bajasNote?, stockFinal }] }
 */
export async function submitRestockDailyEntry(req: Request, res: Response): Promise<void> {
  try {
    const { branch, date, submittedBy, items } = req.body;
    if (!branch || !date || !submittedBy || !Array.isArray(items)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch, date, submittedBy, and items[] are required." });
      return;
    }
    const requestedByUserId = (req as any).user?.id || (req as any).user?._id;
    const data = await posRestockService.submitDailyEntry(branch, date, items, submittedBy, requestedByUserId);

    // Alerta a los Jefes de Operaciones (correo vía Resend). Se espera aquí
    // porque en serverless el proceso muere al responder, pero nunca bloquea:
    // cualquier error solo se loguea dentro del servicio.
    await operationsReportService.sendClosingAlert(branch, date, submittedBy);

    res.status(HttpStatusCode.Ok).send({ message: "Daily entry submitted.", data });
  } catch (error: any) {
    console.error("Error submitting daily entry:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to submit daily entry.", error: error.message });
  }
}

/**
 * GET /api/pos/restock/history?branch=X&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function getRestockHistory(req: Request, res: Response): Promise<void> {
  try {
    const { branch, from, to } = req.query;
    if (!branch || !from || !to) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch, from, and to query params are required." });
      return;
    }
    const data = await posRestockService.getHistory(branch as string, from as string, to as string);
    res.status(HttpStatusCode.Ok).send({ message: "History retrieved.", count: data.length, data });
  } catch (error: any) {
    console.error("Error retrieving restock history:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve history.", error: error.message });
  }
}

/**
 * GET /api/pos/restock/leftovers
 * Query: from, to (YYYY-MM-DD, requeridos), branch (opcional, "all" = todas)
 * F10 — sobrantes de cierre por día y sucursal + cuadre de inventario.
 */
export async function getRestockLeftovers(req: Request, res: Response): Promise<void> {
  try {
    const { from, to, branch } = req.query;
    if (!from || !to) {
      res.status(HttpStatusCode.BadRequest).send({ message: "from and to query params are required." });
      return;
    }
    const data = await posRestockService.getLeftovers({
      from: from as string,
      to: to as string,
      branch: branch as string | undefined,
    });
    res.status(HttpStatusCode.Ok).send({ message: "Leftovers retrieved.", ...data });
  } catch (error: any) {
    console.error("Error retrieving POS leftovers:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to retrieve leftovers.", error: error.message });
  }
}

/**
 * PUT /api/pos/orders/:orderId/settle
 * Marks an order as settled in a physical island branch.
 */
export async function settleOrder(req: Request, res: Response): Promise<void> {
  try {
    const { orderId } = req.params;
    const { islandName } = req.body;

    if (!islandName) {
      res.status(HttpStatusCode.BadRequest).send({ message: "islandName is required in body." });
      return;
    }

    const result = await posService.settleOrder(orderId, islandName);

    res.status(HttpStatusCode.Ok).send({
      message: "Order settled in island successfully.",
      data: result
    });
  } catch (error: any) {
    console.error("Error settling order from POS:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Failed to settle order.", error: error.message });
  }
}
/** Solo Operaciones y administración registran el inventario inicial. */
const INITIAL_INVENTORY_ROLES = ["OPERATIONS_MANAGER", "SUPERADMIN", "ADMIN", "SALES_MANAGER", "RETAILMANAGER"];
function canEditInitialInventory(req: Request): boolean {
  const role = String((req as any).user?.role || "").toUpperCase();
  return INITIAL_INVENTORY_ROLES.includes(role);
}

/** GET /api/pos/initial-inventory?branch=&date=YYYY-MM-DD */
export async function getInitialInventory(req: Request, res: Response): Promise<void> {
  try {
    const branch = String(req.query.branch || "");
    const date = String(req.query.date || "");
    if (!branch || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch y date (AAAA-MM-DD) son obligatorios." });
      return;
    }
    res.status(HttpStatusCode.Ok).send(await posRestockService.getInitialInventory(branch, date));
  } catch (error: any) {
    console.error("Error leyendo inventario inicial:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo leer el inventario inicial." });
  }
}

/** PUT /api/pos/initial-inventory  Body: { branch, date, items: [{ productName, unit, quantity }], note? } */
export async function saveInitialInventory(req: Request, res: Response): Promise<void> {
  try {
    if (!canEditInitialInventory(req)) {
      res.status(HttpStatusCode.Forbidden).send({ message: "Solo Operaciones puede registrar el inventario inicial." });
      return;
    }
    const { branch, date, items, note } = req.body || {};
    if (!branch || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
      res.status(HttpStatusCode.BadRequest).send({ message: "branch y date (AAAA-MM-DD) son obligatorios." });
      return;
    }
    const user = (req as any).user?.name || (req as any).user?.email || "Operaciones";
    const saved = await posRestockService.saveInitialInventory({ branch, date, items, note, user });
    res.status(HttpStatusCode.Ok).send({ message: "Inventario inicial guardado.", data: saved });
  } catch (error: any) {
    if (error?.status === 400) {
      res.status(HttpStatusCode.BadRequest).send({ message: error.message });
      return;
    }
    console.error("Error guardando inventario inicial:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo guardar el inventario inicial." });
  }
}
