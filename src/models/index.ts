import { OrderModel } from "./order.model";
import { DailySummaryModel } from "./daily-summary.model";
import { UserModel } from "./user.model";
import { ParLevelModel } from "./par-level.model";
import { DeliveryPersonModel } from "./delivery-person.model";
import { ProviderModel } from "./provider.model";
import { RawMaterialModel } from "./raw-material.model";
import { POSStockObjectiveModel } from "./pos-stock-objective.model";
import { POSDailyEntryModel } from "./pos-daily-entry.model";
import { POSLossModel } from "./pos-loss.model";
import { SupplierOrderModel } from "./supplier-order.model";
import { GoalSettingsModel } from "./goal-settings.model";
import { ProductionSettingsModel } from "./production-settings.model";
import { ProviderCategoryModel } from "./provider-category.model";
import { WarehouseSettingsModel } from "./warehouse-settings.model";
import { Branch } from "./branch.model";
import { InternalRequisitionModel } from "./internal-requisition.model";
import { WarehouseLoanModel } from "./warehouse-loan.model";
import { SellerModel } from "./seller.model";
import { InvoiceSequenceModel } from "./invoice-sequence.model";
import { NotificationModel } from "./notification.model";

export const models = {
  orders: OrderModel,
  dailySummaries: DailySummaryModel,
  users: UserModel,
  parLevels: ParLevelModel,
  deliveryPersons: DeliveryPersonModel,
  providers: ProviderModel,
  rawMaterials: RawMaterialModel,
  posStockObjectives: POSStockObjectiveModel,
  posDailyEntries: POSDailyEntryModel,
  posLosses: POSLossModel,
  supplierOrders: SupplierOrderModel,
  goalSettings: GoalSettingsModel,
  productionSettings: ProductionSettingsModel,
  providerCategories: ProviderCategoryModel,
  warehouseSettings: WarehouseSettingsModel,
  branches: Branch,
  internalRequisitions: InternalRequisitionModel,
  warehouseLoans: WarehouseLoanModel,
  sellers: SellerModel,
  invoiceSequences: InvoiceSequenceModel,
  notifications: NotificationModel,
};
