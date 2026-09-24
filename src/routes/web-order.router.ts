import express from "express";
import * as WebOrderController from "../controllers/web-order.controller";
import { webOrdersApiKeyMiddleware } from "../middlewares/webOrdersApiKey.middleware";

/**
 * Rutas que llama el backapp de la tienda online. Sin JWT: se autentican con
 * el header `x-api-key` = WEB_ORDERS_API_KEY.
 */
const router = express.Router();

router.use(webOrdersApiKeyMiddleware);

// GET /api/web-orders/contifico-products?q=
router.get("/contifico-products", WebOrderController.searchContificoProducts);

// POST /api/web-orders
router.post("/", WebOrderController.createWebOrder);

// PATCH /api/web-orders/:externalId/payment
router.patch("/:externalId/payment", WebOrderController.updateWebOrderPayment);

export default router;
