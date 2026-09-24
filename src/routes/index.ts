import express, { Application } from "express";
import OrderRouter from "./order.router";
import ProductRouter from "./product.router";
import PersonRouter from "./person.router";
import DocumentRouter from "./document.router";
import AnalyticsRouter from "./analytics.router";
import UserRouter from "./user.router";
import ProductionRouter from "./production.router";
import POSRouter from "./pos.router";
import ReplenishmentRouter from "./replenishment.router";
import DeliveryPersonRouter from "./delivery-person.router";
import ProviderRouter from "./provider.router";
import RawMaterialRouter from "./raw-material.router";
import SupplierOrderRouter from "./supplier-order.router";
import GoalSettingsRouter from "./goal-settings.router";
import ProductionSettingsRouter from "./production-settings.router";
import ProviderCategoryRouter from "./provider-category.router";
import WarehouseSettingsRouter from "./warehouse-settings.router";
import BranchRouter from "./branch.router";
import PayablesRouter from "./payables.router";
import RequisitionRouter from "./requisition.router";
import WarehouseLoanRouter from "./warehouse-loan.router";
import SellerRouter from "./seller.router";
import WebOrderRouter from "./web-order.router";

import { WarehouseRouter } from "./warehouse.routes";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);
  router.use("/orders", OrderRouter);
  router.use("/products", ProductRouter);
  router.use("/persons", PersonRouter);
  router.use("/documents", DocumentRouter);
  router.use("/analytics", AnalyticsRouter);
  router.use("/users", UserRouter);
  router.use("/production", ProductionRouter);
  router.use("/pos", POSRouter);
  router.use("/replenishment", ReplenishmentRouter);
  router.use("/delivery-personnel", DeliveryPersonRouter);
  router.use("/providers", ProviderRouter);
  router.use("/raw-materials", RawMaterialRouter);
  router.use("/supplier-orders", SupplierOrderRouter);
  router.use("/settings/goals", GoalSettingsRouter);
  router.use("/settings/production", ProductionSettingsRouter);
  router.use("/settings/warehouse", WarehouseSettingsRouter);
  router.use("/branches", BranchRouter);
  router.use("/sellers", SellerRouter);
  router.use("/web-orders", WebOrderRouter);

  router.use("/provider-categories", ProviderCategoryRouter);
  router.use("/warehouse", WarehouseRouter);
  router.use("/warehouse-loans", WarehouseLoanRouter);
  router.use("/payables", PayablesRouter);
  router.use("/requisitions", RequisitionRouter);
}

export default routerApi;
