import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { models } from "../models";
import { AuthRequest } from "../types/AuthRequest";
import { phoneSearchRegex } from "../utils/phone.utils";
import { RESERVA_METHOD, STATUS_PENDING, isDiscarded, isReservaOrder, restoreFromDiscard, hasPayment } from "../utils/reserva";

/** Panel de reservas sin pago: seguimiento comercial (ver utils/reserva.ts). */

const ROLES = ["admin", "superadmin", "SALES_MANAGER", "sales", "SALES_REP"];
const NOTE_MAX = 500;
const LIST_LIMIT = 500;
const BULK_LIMIT = 100;

export const DISCARD_REASONS: Record<string, string> = {
  no_response: "No respondió",
  not_interested: "No le interesó",
  duplicate: "Duplicada",
  other: "Otro",
};

const LIST_FIELDS =
  "customerName customerPhone totalValue status webOrder deliveryDate deliveryTime deliveryType products.name products.quantity payments createdAt productionStage voidedAt contificoSource settledInIsland";

const IS_RESERVA = { "webOrder.paymentMethod": RESERVA_METHOD };

/** Reserva abierta: todavía se puede contactar. */
const ACTIVE = {
  ...IS_RESERVA,
  status: STATUS_PENDING,
  "webOrder.discard.at": null,
  voidedAt: null,
};

/** Se repite en el update: si la pagan mientras se descarta, el descarte no se aplica. */
const DISCARDABLE = {
  ...ACTIVE,
  "payments.0": { $exists: false },
  "webOrder.paymentStatus": { $ne: "PAID" },
  "webOrder.paymentProofUrl": null,
  settledInIsland: { $ne: true },
  invoiceStatus: { $ne: "PROCESSED" },
  productionStage: { $in: ["PENDING", "DELAYED"] },
  dispatchStatus: { $nin: ["SENT", "PARTIAL"] },
};

const PAID_OR_CONTACTED = [
  { "webOrder.contactLog.0": { $exists: true } },
  { "payments.0": { $exists: true } },
  { "webOrder.paymentStatus": "PAID" },
  { settledInIsland: true },
];

/** Una reserva cobrada sin marcar como contactada ya no está esperando un primer contacto. */
const STATE_QUERIES: Record<string, any> = {
  pending: { ...ACTIVE, productionStage: { $ne: "VOID" }, $nor: PAID_OR_CONTACTED },
  contacted: { ...ACTIVE, productionStage: { $ne: "VOID" }, $or: PAID_OR_CONTACTED },
  managed: { ...IS_RESERVA, status: { $ne: STATUS_PENDING }, "webOrder.discard.at": null },
  discarded: { ...IS_RESERVA, "webOrder.discard.at": { $ne: null } },
  all: IS_RESERVA,
};

/** Por qué no se puede descartar, en palabras del equipo. Null si se puede. */
function discardBlock(order: any): string | null {
  if (!isReservaOrder(order)) return "No es una reserva.";
  if (isDiscarded(order)) return "Ya estaba descartada.";
  if (order.status !== STATUS_PENDING) return "Ya está gestionada.";
  if (order.voidedAt || order.productionStage === "VOID") return "Está anulada.";
  if (hasPayment(order)) return "Ya tiene un cobro registrado.";
  if (order.webOrder?.paymentProofUrl) return "Tiene un comprobante por verificar.";
  if (order.invoiceStatus === "PROCESSED") return "Ya está facturada.";
  if (!["PENDING", "DELAYED"].includes(order.productionStage)) return "Ya entró a producción.";
  if (["SENT", "PARTIAL"].includes(order.dispatchStatus)) return "Ya fue despachada.";
  return null;
}

const userOf = (req: AuthRequest): string => req.user?.name || req.user?.email || "Usuario";
const allowed = (req: AuthRequest): boolean => ROLES.includes(String(req.user?.role || ""));
const cleanNote = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, NOTE_MAX) : "";

function deny(res: Response): void {
  res.status(HttpStatusCode.Forbidden).send({ message: "No tienes permiso para gestionar reservas." });
}

/** GET /api/orders/reservas?state=&brand=&search= → lista del estado + contadores de todos. */
export async function listReservas(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!allowed(req)) return deny(res);

    const state = String(req.query.state || "pending");
    if (!STATE_QUERIES[state]) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Estado de reserva inválido." });
      return;
    }

    const scope: any = {};
    if (req.query.brand === "sucree") scope.contificoSource = "sucree";
    else if (req.query.brand === "nicole") scope.contificoSource = { $ne: "sucree" };

    const search = String(req.query.search || "").trim();
    if (search) {
      const text = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const phone = phoneSearchRegex(search);
      scope.$and = [{
        $or: [
          { customerName: text },
          { "webOrder.code": text },
          { "webOrder.buyer.name": text },
          { "webOrder.customerEmail": text },
          ...(phone ? [{ customerPhone: phone }, { "webOrder.buyer.phone": phone }] : []),
        ],
      }];
    }

    // La más antigua primero mientras alguien espera respuesta; el historial, lo reciente primero.
    const direction = state === "pending" || state === "contacted" ? 1 : -1;
    const [orders, reminderRows, ...counts] = await Promise.all([
      models.orders
        .find({ ...STATE_QUERIES[state], ...scope })
        .select(LIST_FIELDS)
        .sort({ createdAt: direction })
        .limit(LIST_LIMIT)
        .lean(),
      // Lo que rindió el correo de recordatorio: quiénes volvieron y cuánto terminó en venta.
      models.orders.aggregate([
        { $match: { ...IS_RESERVA, "webOrder.reminder.clickedAt": { $ne: null }, ...scope } },
        {
          $group: {
            _id: null,
            returned: { $sum: 1 },
            recoveredTotal: { $sum: { $cond: [{ $eq: ["$status", STATUS_PENDING] }, 0, "$totalValue"] } },
          },
        },
      ]),
      ...Object.values(STATE_QUERIES).map((query) => models.orders.countDocuments({ ...query, ...scope })),
    ]);

    res.status(HttpStatusCode.Ok).send({
      orders,
      counts: Object.fromEntries(Object.keys(STATE_QUERIES).map((key, i) => [key, counts[i]])),
      reminders: {
        returned: reminderRows[0]?.returned || 0,
        recoveredTotal: reminderRows[0]?.recoveredTotal || 0,
      },
      limit: LIST_LIMIT,
    });
  } catch (error) {
    next(error);
  }
}

/** Aplica un cambio sobre una reserva abierta; responde 409 si ya no lo está. */
async function updateActive(req: AuthRequest, res: Response, extraFilter: any, update: any, message: string) {
  const { id } = req.params;
  if (!Types.ObjectId.isValid(String(id))) {
    res.status(HttpStatusCode.NotFound).send({ message: "Reserva no encontrada." });
    return;
  }
  const order = await models.orders.findOneAndUpdate(
    { _id: id, ...ACTIVE, ...extraFilter },
    { ...update, $set: { ...update.$set, updatedBy: userOf(req) } },
    { new: true },
  );
  if (!order) {
    res.status(HttpStatusCode.Conflict).send({ message: "La reserva cambió de estado. Actualiza la lista." });
    return;
  }
  res.status(HttpStatusCode.Ok).send({ message, order });
}

/** POST /api/orders/:id/reserva/contact — registra un contacto; repetirlo es el seguimiento. */
export async function markContacted(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!allowed(req)) return deny(res);
    const by = userOf(req);
    const at = new Date();
    const note = cleanNote(req.body?.note);
    await updateActive(req, res, {}, {
      $push: {
        "webOrder.contactLog": { at, by, ...(note ? { note } : {}) },
        auditLog: { user: by, action: "Reserva contactada", at, details: note || "Sin nota" },
      },
    }, "Reserva marcada como contactada.");
  } catch (error) {
    next(error);
  }
}

/** POST /api/orders/:id/reserva/contact/undo — quita el último contacto registrado. */
export async function undoContact(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!allowed(req)) return deny(res);
    const by = userOf(req);
    await updateActive(req, res, { "webOrder.contactLog.0": { $exists: true } }, {
      $pop: { "webOrder.contactLog": 1 },
      $push: { auditLog: { user: by, action: "Contacto de reserva deshecho", at: new Date(), details: "Marcado por error" } },
    }, "Contacto deshecho.");
  } catch (error) {
    next(error);
  }
}

/** PATCH /api/orders/:id/reserva/contact/note — nota del último contacto. */
export async function setContactNote(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!allowed(req)) return deny(res);
    const current = Types.ObjectId.isValid(String(req.params.id))
      ? await models.orders.findById(req.params.id).select("webOrder.contactLog").lean()
      : null;
    const last = ((current as any)?.webOrder?.contactLog?.length || 0) - 1;
    if (last < 0) {
      res.status(HttpStatusCode.Conflict).send({ message: "La reserva todavía no tiene un contacto registrado." });
      return;
    }
    const by = userOf(req);
    const note = cleanNote(req.body?.note);
    await updateActive(req, res, { [`webOrder.contactLog.${last}`]: { $exists: true } }, {
      $set: { [`webOrder.contactLog.${last}.note`]: note },
      $push: { auditLog: { user: by, action: "Nota de contacto de reserva", at: new Date(), details: note || "Nota borrada" } },
    }, "Nota guardada.");
  } catch (error) {
    next(error);
  }
}

/** POST /api/orders/reservas/discard { ids, reason?, note? } — descarta una o varias. */
export async function discardReservas(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!allowed(req)) return deny(res);

    const ids: string[] = Array.isArray(req.body?.ids)
      ? [...new Set<string>(req.body.ids.map(String))].filter((id) => Types.ObjectId.isValid(id))
      : [];
    if (ids.length === 0 || ids.length > BULK_LIMIT) {
      res.status(HttpStatusCode.BadRequest).send({ message: `Elige entre 1 y ${BULK_LIMIT} reservas.` });
      return;
    }
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    if (reason && !DISCARD_REASONS[reason]) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Motivo inválido." });
      return;
    }

    const by = userOf(req);
    const note = cleanNote(req.body?.note);
    const at = new Date();
    const details = [reason ? DISCARD_REASONS[reason] : "Sin motivo", note].filter(Boolean).join(" · ");
    const orders: any[] = await models.orders.find({ _id: { $in: ids } }).lean();

    const discarded: string[] = [];
    const skipped: Array<{ id: string; customerName?: string; reason: string }> = [];
    for (const order of orders) {
      const id = String(order._id);
      const block = discardBlock(order);
      if (block) {
        skipped.push({ id, customerName: order.customerName, reason: block });
        continue;
      }
      const result = await models.orders.updateOne(
        { ...DISCARDABLE, _id: order._id, productionStage: order.productionStage },
        {
          $set: {
            "webOrder.discard": { at, by, ...(reason ? { reason } : {}), ...(note ? { note } : {}), previousStage: order.productionStage },
            productionStage: "VOID",
            voidedAt: at,
            updatedBy: by,
          },
          $push: { auditLog: { user: by, action: "Reserva descartada", at, details } },
        },
      );
      if (result.modifiedCount === 1) discarded.push(id);
      else skipped.push({ id, customerName: order.customerName, reason: "Cambió de estado mientras se descartaba." });
    }

    res.status(HttpStatusCode.Ok).send({ discarded, skipped });
  } catch (error) {
    next(error);
  }
}

/** POST /api/orders/:id/reserva/restore — devuelve una descartada a donde estaba. */
export async function restoreReserva(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!allowed(req)) return deny(res);
    const order = Types.ObjectId.isValid(String(req.params.id)) ? await models.orders.findById(req.params.id) : null;
    if (!order || !isReservaOrder(order)) {
      res.status(HttpStatusCode.NotFound).send({ message: "Reserva no encontrada." });
      return;
    }
    if (!isDiscarded(order)) {
      res.status(HttpStatusCode.Conflict).send({ message: "Esta reserva no está descartada." });
      return;
    }
    restoreFromDiscard(order, userOf(req), "Recuperada desde Descartadas");
    await order.save();
    res.status(HttpStatusCode.Ok).send({ message: "Reserva recuperada.", order });
  } catch (error) {
    next(error);
  }
}
