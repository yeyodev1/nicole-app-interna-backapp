import { Router } from "express";
import { getProductionTasks, updateProductionTask, getItemsSummary, batchUpdateProductionTasks, registerProgress, updateItemStatus, getAllProductionOrders, registerDispatchOrder, editDispatchOrder, getProductionReports, batchRegisterDispatchOrder, registerDispatchProgress, voidOrder, restoreOrder, revertOrder, returnOrder, batchRegisterProgress } from "../controllers/production.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { getFutureSales } from "../controllers/future-sales.controller";

const productionRouter = Router();

productionRouter.get("/", getProductionTasks);
productionRouter.post("/dispatch/progress", registerDispatchProgress); // New item-based dispatch endpoint
productionRouter.post("/dispatch/batch", batchRegisterDispatchOrder); // New batch endpoint
productionRouter.get("/reports", getProductionReports); // New reports endpoint
productionRouter.get("/all-orders", getAllProductionOrders);
productionRouter.get("/summary", getItemsSummary);
productionRouter.get("/future-sales", authMiddleware as any, getFutureSales);
productionRouter.patch("/batch", batchUpdateProductionTasks);
productionRouter.post("/progress", registerProgress);
productionRouter.post("/progress/batch", batchRegisterProgress);
productionRouter.patch("/:id/product-status", authMiddleware as any, updateItemStatus);
productionRouter.patch("/:id", authMiddleware as any, updateProductionTask);

// Dispatch Routes
productionRouter.post("/:id/dispatch", registerDispatchOrder);
productionRouter.put("/:id/dispatch/:dispatchId", editDispatchOrder);

// Void & Restore
productionRouter.patch("/:id/void", voidOrder);
// productionRouter.patch("/:id/revert", revertOrder);
// productionRouter.put("/:id/return", returnOrder);
productionRouter.patch("/:id/restore", restoreOrder);

export default productionRouter;
