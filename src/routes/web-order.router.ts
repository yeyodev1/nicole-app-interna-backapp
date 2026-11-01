import express from "express";
import * as WebOrderController from "../controllers/web-order.controller";
import * as ClientLinkController from "../controllers/client-link.controller";
import { webOrdersApiKeyMiddleware } from "../middlewares/webOrdersApiKey.middleware";

/**
 * Rutas que llama el backapp de la tienda online. Sin JWT: se autentican con
 * el header `x-api-key` = WEB_ORDERS_API_KEY.
 */
const router = express.Router();

router.use(webOrdersApiKeyMiddleware);

// GET /api/web-orders/contifico-products?q=
router.get("/contifico-products", WebOrderController.searchContificoProducts);

// GET /api/web-orders/status?externalIds=a,b,c (solo lectura, máx. 100)
router.get("/status", WebOrderController.getWebOrderStatuses);

// GET /api/web-orders/delivery-slots?date=YYYY-MM-DD (cupo de 8 deliveries por hora)
router.get("/delivery-slots", WebOrderController.getDeliverySlots);

// GET /api/web-orders/notify-recipients (correos de administradores de ventas para los avisos)
router.get("/notify-recipients", WebOrderController.getNotifyRecipients);

// GET /api/web-orders/client-links/:token — link de gestión de entrega (v8)
router.get("/client-links/:token", ClientLinkController.getClientLinkPublic);

// POST /api/web-orders/client-links/:token/complete
router.post("/client-links/:token/complete", ClientLinkController.completeClientLinkPublic);

// POST /api/web-orders
router.post("/", WebOrderController.createWebOrder);

// PATCH /api/web-orders/:externalId/payment
router.patch("/:externalId/payment", WebOrderController.updateWebOrderPayment);

export default router;
