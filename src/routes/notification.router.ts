import { Router } from "express";
import * as NotificationController from "../controllers/notification.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.use(authMiddleware as any);

// GET /api/notifications?limit=30
router.get("/", NotificationController.getNotifications);

// POST /api/notifications/read-all
router.post("/read-all", NotificationController.markAllNotificationsRead);

// PATCH /api/notifications/:id/read
router.patch("/:id/read", NotificationController.markNotificationRead);

export default router;
