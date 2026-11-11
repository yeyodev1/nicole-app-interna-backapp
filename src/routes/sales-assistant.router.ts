import { Router } from "express";
import * as SalesAssistantController from "../controllers/sales-assistant.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.use(authMiddleware as any);

// GET /api/sales-assistant/latest
router.get("/latest", SalesAssistantController.getLatest as any);

// GET /api/sales-assistant/history
router.get("/history", SalesAssistantController.getHistory as any);

// GET /api/sales-assistant/analyses/:id
router.get("/analyses/:id", SalesAssistantController.getAnalysis as any);

// POST /api/sales-assistant/analyze
router.post("/analyze", SalesAssistantController.analyze as any);

// PUT /api/sales-assistant/marks/:key
router.put("/marks/:key", SalesAssistantController.setMark as any);

export default router;
