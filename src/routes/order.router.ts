import express from "express";
import * as OrderController from "../controllers/order.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = express.Router();

// POST /api/orders
router.post("/", authMiddleware as any, OrderController.createOrder);

// GET /api/orders
router.get("/", authMiddleware as any, OrderController.getOrders);

// GET /api/orders/invoice-status
router.get("/invoice-status", authMiddleware as any, OrderController.getInvoiceStatus);

// GET /api/orders/reports/delivery
router.get("/reports/delivery", OrderController.getDeliveryReport);

// GET /api/orders/:id
router.get("/:id", OrderController.getOrderById);

// PUT /api/orders/:id
router.put("/:id", authMiddleware as any, OrderController.updateOrder);

// POST /api/orders/bulk-assign
router.post("/bulk-assign", OrderController.bulkAssignOrders);

// POST /api/orders/reassign-delivery
router.post("/reassign-delivery", OrderController.reassignDelivery);

// POST /api/orders/batch-invoice (Protected by Cron)
router.post("/batch-invoice", OrderController.processPendingInvoices);

// POST /api/orders/invoice/batch-reauthorize
router.post("/invoice/batch-reauthorize", authMiddleware as any, OrderController.batchReauthorizeInvoices);

// POST /api/orders/invoice/sync-authorizations — pull autorizacion from Contifico → DB
router.post("/invoice/sync-authorizations", authMiddleware as any, OrderController.syncInvoiceAuthorizations);

// POST /api/orders/invoice/generate-missing — create invoices for orders that never got one
router.post("/invoice/generate-missing", authMiddleware as any, OrderController.generateMissingInvoices);

// PUT /api/orders/:id/invoice
router.put("/:id/invoice", OrderController.updateInvoiceData);

// POST /api/orders/:id/collection
router.post("/:id/collection", authMiddleware as any, OrderController.registerCollection);

// POST /api/orders/:id/invoice/generate
router.post("/:id/invoice/generate", OrderController.generateInvoice);

// GET /api/orders/:id/invoice-pdf
router.get("/:id/invoice-pdf", OrderController.getInvoicePdf);

// GET /api/orders/:id/invoice/auth-status
router.get("/:id/invoice/auth-status", OrderController.getInvoiceAuthStatus);

// POST /api/orders/:id/invoice/authorize
router.post("/:id/invoice/authorize", OrderController.triggerInvoiceAuth);

// POST /api/orders/:id/invoice/regenerate (elimina doc Contifico roto y lo recrea)
router.post("/:id/invoice/regenerate", authMiddleware as any, OrderController.regenerateInvoice);

// POST /api/orders/:id/settle-island
router.post("/:id/settle-island", OrderController.settleOrderInIsland);

// PATCH /api/orders/:id/web-managed — pedido de la tienda online marcado como gestionado
router.patch("/:id/web-managed", authMiddleware as any, OrderController.markWebOrderManaged);

// PUT /api/orders/:id/return
router.put("/:id/return", authMiddleware as any, OrderController.returnOrder);

// DELETE /api/orders/:id
router.delete("/:id", OrderController.deleteOrder);

export default router;
