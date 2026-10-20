import express from "express";
import {
  getIncomingDispatches,
  confirmReception,
  getPickupOrders,
  deliverPickupOrder,
  getRestockObjectives,
  upsertRestockObjective,
  getRestockDailyForm,
  getRestockDailySales,
  submitRestockDailyEntry,
  getRestockHistory,
  getRestockLeftovers,
  deleteRestockObjective,
  settleOrder,
} from "../controllers/pos.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = express.Router();

// Apply auth middleware to all POS routes
router.use(authMiddleware);

// GET /api/pos/dispatches?branch=San%20Marino
router.get("/dispatches", getIncomingDispatches);

// POST /api/pos/dispatches/:orderId/:dispatchId/confirm
router.post("/dispatches/:orderId/:dispatchId/confirm", confirmReception);

// GET /api/pos/pickups?branch=San%20Marino
router.get("/pickups", getPickupOrders);

// PUT /api/pos/pickups/:orderId/deliver
router.put("/pickups/:orderId/deliver", deliverPickupOrder);

// Restock — physical count system
router.get("/restock/objectives", getRestockObjectives);
router.post("/restock/objectives", upsertRestockObjective);
router.delete("/restock/objectives/:productName", deleteRestockObjective);
router.get("/restock/daily-form", getRestockDailyForm);
router.get("/restock/daily-sales", getRestockDailySales);
router.post("/restock/daily-entry", submitRestockDailyEntry);
router.get("/restock/history", getRestockHistory);
router.get("/restock/leftovers", getRestockLeftovers);

// Settle order in island
router.put("/orders/:orderId/settle", settleOrder);

export default router;
