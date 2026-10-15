import { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { models } from "../models";
import CustomError from "../errors/customError.error";
import { AuthRequest } from "../types/AuthRequest";
import {
  CLIENT_LINK_TTL_DAYS,
  clientLinkStatus,
  clientLinkUrl,
  clientWhatsappMessage,
  completeClientLink,
  findOrderByToken,
  publicClientLinkView,
  runClientLinkCron,
} from "../services/client-link.service";
import { createPayphoneLink } from "../services/payphone.service";

/**
 * Link de gestión de entrega (contrato v8). Ver services/client-link.service.ts.
 */

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof CustomError) {
    res.status(error.status).send({ message: error.message });
    return;
  }
  console.error(`❌ ${fallback}:`, error);
  res.status(HttpStatusCode.InternalServerError).send({ message: fallback });
}

// ─── Tienda (x-api-key) ─────────────────────────────────────────────────────

/** GET /api/web-orders/client-links/:token */
export async function getClientLinkPublic(req: Request, res: Response, _next: NextFunction) {
  try {
    const order = await findOrderByToken(String(req.params.token));
    res.status(HttpStatusCode.Ok).send(publicClientLinkView(order));
  } catch (error) {
    sendError(res, error, "No se pudo leer el link");
  }
}

/** POST /api/web-orders/client-links/:token/complete */
export async function completeClientLinkPublic(req: Request, res: Response, _next: NextFunction) {
  try {
    const result = await completeClientLink(String(req.params.token), req.body);
    res.status(HttpStatusCode.Ok).send(result);
  } catch (error) {
    sendError(res, error, "No se pudo guardar la entrega");
  }
}

// ─── App interna (JWT) ──────────────────────────────────────────────────────

/** POST /api/orders/:id/client-link/renew — otros 7 días desde hoy. */
export async function renewClientLink(req: AuthRequest, res: Response, _next: NextFunction) {
  try {
    const id = String(req.params.id);
    if (!Types.ObjectId.isValid(id)) throw new CustomError("Pedido no encontrado.", 404);
    const order: any = await models.orders.findById(id);
    if (!order?.clientLink) throw new CustomError("Este pedido no tiene link del cliente.", 404);
    if (clientLinkStatus(order.clientLink) === "COMPLETED") {
      throw new CustomError("El cliente ya completó este link; los cambios se hacen en el pedido.", 409);
    }
    order.clientLink.expiresAt = new Date(Date.now() + CLIENT_LINK_TTL_DAYS * 24 * 3600 * 1000);
    order.markModified("clientLink");
    order.auditLog.push({
      user: req.user?.name || req.user?.email || "Sistema",
      action: "Link del cliente renovado",
      at: new Date(),
      details: `Vence el ${order.clientLink.expiresAt.toLocaleDateString("es-EC", { timeZone: "America/Guayaquil" })}`,
    });
    await order.save();
    res.status(HttpStatusCode.Ok).send({
      order,
      clientLinkUrl: clientLinkUrl(order.clientLink.token),
      clientWhatsappMessage: clientWhatsappMessage(order),
    });
  } catch (error) {
    sendError(res, error, "No se pudo renovar el link");
  }
}

/** POST /api/payphone/links */
export async function createPayphoneLinkHandler(req: AuthRequest, res: Response, _next: NextFunction) {
  try {
    const { amountWithTaxCents, taxCents, amountWithoutTaxCents, reference } = req.body || {};
    const url = await createPayphoneLink({
      amountWithTaxCents: Number(amountWithTaxCents),
      taxCents: Number(taxCents),
      amountWithoutTaxCents: Number(amountWithoutTaxCents),
      reference: String(reference || "Pedido Nicole Pastry"),
      clientTransactionId: String(req.body?.clientTransactionId || `NP-${Date.now().toString(36).toUpperCase()}`),
    });
    res.status(HttpStatusCode.Ok).send({ url });
  } catch (error) {
    sendError(res, error, "No se pudo generar el link de Payphone");
  }
}

// ─── Cron (CRON_SECRET) ─────────────────────────────────────────────────────

/** POST /api/orders/client-links/cron — lo llama GitHub Actions cada hora. */
export async function clientLinksCron(req: Request, res: Response, _next: NextFunction) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = String(req.headers["authorization"] || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  // A diferencia del cron de facturas, sin CRON_SECRET queda cerrado: envía correos.
  if (!cronSecret || token !== cronSecret) {
    res.status(HttpStatusCode.Unauthorized).send({ message: "Unauthorized." });
    return;
  }
  try {
    const result = await runClientLinkCron();
    console.log("[client-links-cron]", result);
    res.status(HttpStatusCode.Ok).send(result);
  } catch (error) {
    sendError(res, error, "Falló el cron de links");
  }
}
