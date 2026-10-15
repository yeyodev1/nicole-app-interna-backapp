import { Router } from "express";
import * as ClientLinkController from "../controllers/client-link.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.use(authMiddleware as any);

// POST /api/payphone/links — link de pago que el asesor le manda al cliente
router.post("/links", ClientLinkController.createPayphoneLinkHandler);

export default router;
