import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getInventoryCatalog,
  saveInventoryCatalog,
  getInventoryWeek,
  saveInventoryBlock,
  closeInventoryBlock,
  reopenInventoryBlock,
  startInventoryCount,
  createInventoryUtensil,
} from "../controllers/inventory.controller";
import { getInventoryMovement, getInventoryMovementPeriods, saveInventoryMovementNote } from "../controllers/inventory-movement.controller";

// Toma de inventario (una por día; el mismo día se puede reabrir un bloque cerrado). Todo pide JWT; cada controlador valida el rol:
// la toma la hacen Producción y el Jefe de Operaciones; los Ajustes, solo el Jefe de Operaciones.
const router = Router();
router.use(authMiddleware as any);

router.get("/catalog", getInventoryCatalog);
router.put("/catalog", saveInventoryCatalog);
router.get("/week", getInventoryWeek);
router.put("/week/blocks/:block", saveInventoryBlock);
router.post("/week/blocks/:block/close", closeInventoryBlock);
router.post("/week/blocks/:block/reopen", reopenInventoryBlock);
router.post("/week/new", startInventoryCount);
router.post("/utensils", createInventoryUtensil);
// Movimiento de inventario (producto terminado): toma → producción − despachos → toma siguiente. Solo lectura.
router.get("/movement/periods", getInventoryMovementPeriods);
router.get("/movement", getInventoryMovement);
// Comentarios por producto y periodo (cualquier producto, haya o no diferencia).
router.put("/movement/notes", saveInventoryMovementNote);

export default router;
