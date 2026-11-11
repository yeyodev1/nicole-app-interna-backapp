import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getTabletData,
  createProductionEntry,
  getProductionHistory,
  listProductionOperators,
  addProductionOperator,
  removeProductionOperator,
} from "../controllers/production-entry.controller";

// Ingreso de producción (tablet de planta) e Histórico (Jefe de Operaciones). Todo pide JWT;
// cada controlador valida el rol.
const router = Router();
router.use(authMiddleware as any);

router.get("/tablet", getTabletData);
router.post("/", createProductionEntry);
router.get("/history", getProductionHistory);
router.get("/operators", listProductionOperators);
router.post("/operators", addProductionOperator);
router.delete("/operators/:id", removeProductionOperator);

export default router;
