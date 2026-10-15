import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { models } from "../models";
import { AuthRequest } from "../types/AuthRequest";

/** Notificaciones de la campana. Cada usuario ve solo las suyas. */

async function currentUserId(req: AuthRequest): Promise<Types.ObjectId | null> {
  if (req.user?.id && Types.ObjectId.isValid(req.user.id)) return new Types.ObjectId(req.user.id);
  if (!req.user?.email) return null;
  const user = await models.users.findOne({ email: req.user.email }).select("_id").lean();
  return (user?._id as Types.ObjectId) || null;
}

/** GET /api/notifications?limit=30 */
export async function getNotifications(req: AuthRequest, res: Response, _next: NextFunction) {
  try {
    const user = await currentUserId(req);
    if (!user) {
      res.status(HttpStatusCode.Ok).send({ notifications: [], unread: 0 });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const [notifications, unread] = await Promise.all([
      models.notifications.find({ user }).sort({ createdAt: -1 }).limit(limit).lean(),
      models.notifications.countDocuments({ user, readAt: null }),
    ]);
    res.status(HttpStatusCode.Ok).send({ notifications, unread });
  } catch (error) {
    console.error("❌ Error en getNotifications:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudieron leer las notificaciones." });
  }
}

/** PATCH /api/notifications/:id/read */
export async function markNotificationRead(req: AuthRequest, res: Response, _next: NextFunction) {
  try {
    const user = await currentUserId(req);
    const id = String(req.params.id);
    if (!user || !Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.NotFound).send({ message: "Notificación no encontrada." });
      return;
    }
    await models.notifications.updateOne({ _id: id, user, readAt: null }, { readAt: new Date() });
    res.status(HttpStatusCode.Ok).send({ ok: true });
  } catch (error) {
    console.error("❌ Error en markNotificationRead:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo marcar como leída." });
  }
}

/** POST /api/notifications/read-all */
export async function markAllNotificationsRead(req: AuthRequest, res: Response, _next: NextFunction) {
  try {
    const user = await currentUserId(req);
    if (user) await models.notifications.updateMany({ user, readAt: null }, { readAt: new Date() });
    res.status(HttpStatusCode.Ok).send({ ok: true });
  } catch (error) {
    console.error("❌ Error en markAllNotificationsRead:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudieron marcar como leídas." });
  }
}
