import { models } from "../models";
import { Types } from "mongoose";

export class POSService {

  /**
   * Retrieves all orders for a specific branch.
   * Calculates a consolidated status for the POS UI.
   */
  async getIncomingDispatches(branch?: string, filters: any = {}) {
    const query: any = {};
    if (branch && branch !== 'Todas las sucursales') {
      query.branch = { $regex: new RegExp(`^${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
    }

    // --- Search Filter ---
    if (filters.search) {
      const searchRegex = new RegExp(filters.search, "i");
      query.$or = [
        { "orderNumber": searchRegex },
        { "customerName": searchRegex }
      ];
    }

    // --- Date Filter (Delivery Date) ---
    if (filters.startDate && filters.endDate) {
      query.deliveryDate = {
        $gte: new Date(filters.startDate),
        $lte: new Date(filters.endDate)
      };
    }

    if (filters.receptionStatus) {
      if (Array.isArray(filters.receptionStatus)) {
        query["dispatches.receptionStatus"] = { $in: filters.receptionStatus };
      } else {
        query["dispatches.receptionStatus"] = filters.receptionStatus;
      }
    }

    // Fetch orders
    const orders = await models.orders.find(query)
      .sort({ deliveryDate: -1 })
      .select("orderNumber customerName deliveryDate deliveryTime products totalValue paymentMethod status dispatches payments settledInIsland isGlobalCourtesy globalDiscountPercentage branch")
      .lean();

    // Map to normalized POS status
    return orders.map((order: any) => {
      let posStatus = "NOT_SENT"; // Gray

      if (order.status === "DELIVERED") {
        posStatus = "DELIVERED"; // Green
      } else if (order.dispatches && order.dispatches.length > 0) {
        // PROBLEM = recibido con novedad: ya se receptó en ese punto
        const allReceived = order.dispatches.every((d: any) => ["RECEIVED", "PROBLEM"].includes(d.receptionStatus));
        if (allReceived) {
          posStatus = "RECEIVED"; // Blue
        } else {
          posStatus = "IN_TRANSIT"; // Yellow
        }
      }

      return {
        ...order,
        posStatus
      };
    });
  }

  /**
   * Register reception of a specific dispatch.
   */
  async registerReception(orderId: string, dispatchId: string, receptionData: {
    receivedBy: string,
    receptionNotes?: string,
    items: { productId: string, quantityReceived: number, itemStatus: string, itemNote?: string }[]
  }) {

    if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(dispatchId)) {
      throw new Error("Invalid ID format");
    }

    const order = await models.orders.findById(orderId);
    if (!order) throw new Error("Order not found");

    const dispatch = order.dispatches.find((d: any) => d._id.toString() === dispatchId);
    if (!dispatch) throw new Error("Dispatch not found");

    // Update Dispatch Header
    dispatch.receivedAt = new Date();
    dispatch.receivedBy = receptionData.receivedBy;
    dispatch.receptionNotes = receptionData.receptionNotes;

    // Update Items
    let hasIssues = false;

    if (receptionData.items && Array.isArray(receptionData.items)) {
      receptionData.items.forEach(receivedItem => {
        const itemInDispatch = dispatch.items.find((item: any) =>
          item.productId.toString() === receivedItem.productId
        );

        if (itemInDispatch) {
          itemInDispatch.quantityReceived = receivedItem.quantityReceived;
          itemInDispatch.itemStatus = receivedItem.itemStatus as "OK" | "MISSING" | "DAMAGED" | "BAD_CONDITION";
          if (receivedItem.itemNote !== undefined) itemInDispatch.itemNote = receivedItem.itemNote;

          if (
            itemInDispatch.itemStatus !== 'OK' ||
            itemInDispatch.quantityReceived !== itemInDispatch.quantitySent
          ) {
            hasIssues = true;
          }
        }
      });
    }

    dispatch.receptionStatus = hasIssues ? "PROBLEM" : "RECEIVED";
    dispatch.modifiedAt = new Date();

    await order.save();
    return dispatch;
  }

  /**
   * Get orders for pickup for a specific branch.
   */
  async getPickupOrders(branch?: string, filters: any = {}) {
    const query: any = {};
    if (branch && branch !== 'Todas las sucursales') {
      query.branch = { $regex: new RegExp(`^${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
    }

    if (filters.search) {
      const searchRegex = new RegExp(filters.search, "i");
      query.$or = [
        { "orderNumber": searchRegex },
        { "customerName": searchRegex }
      ];
    }

    if (filters.startDate && filters.endDate) {
      query.deliveryDate = {
        $gte: new Date(filters.startDate),
        $lte: new Date(filters.endDate)
      };
    }

    // Fetch all for now, we'll filter by "RECEIVED" if requested or let controller/frontend do it
    const orders = await models.orders.find(query)
      .sort({ deliveryDate: 1 })
      .select("orderNumber customerName deliveryDate deliveryTime products productionStatus totalValue paymentMethod paymentDetails payments status dispatches settledInIsland isGlobalCourtesy globalDiscountPercentage branch")
      .lean();

    return orders.map((order: any) => {
      let posStatus = "NOT_SENT";
      if (order.status === "DELIVERED") {
        posStatus = "DELIVERED";
      } else if (order.dispatches && order.dispatches.length > 0) {
        const allReceived = order.dispatches.every((d: any) => ["RECEIVED", "PROBLEM"].includes(d.receptionStatus));
        if (allReceived) {
          posStatus = "RECEIVED";
        } else {
          posStatus = "IN_TRANSIT";
        }
      }

      return {
        ...order,
        posStatus
      };
    });
  }

  /**
   * Mark a pickup order as delivered.
   */
  async markAsDelivered(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new Error("Invalid order ID format");
    }

    const order = await models.orders.findById(orderId);
    if (!order) throw new Error("Order not found");

    // Skip step logic: If not received, we just proced. 
    // We could automatically mark dispatches as received here if we want to be strict,
    // but the user says "indicar que se saltara un paso", so we just set status to DELIVERED.

    order.status = "DELIVERED";
    // Also update production stage or dispatch status if needed? 
    // For now, let's keep it focused on the top-level status.

    await order.save();
    return order;
  }

  /**
   * Mark an order as settled in a physical island (Branch).
   */
  async settleOrder(orderId: string, islandName: string) {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new Error("Invalid order ID format");
    }

    const order = await models.orders.findById(orderId);
    if (!order) throw new Error("Order not found");

    // Update settlement fields
    order.settledInIsland = true;
    order.settledIslandName = islandName;

    // Record 'ISLA' payment to mark as "Paid"
    const amountToSettle = order.totalValue;

    // Avoid duplicates if already settled or has ISLA payment
    const hasIslaPayment = (order.payments || []).some((p: any) => p.forma_cobro === 'ISLA' && p.monto === amountToSettle);

    if (!hasIslaPayment) {
      order.payments.push({
        forma_cobro: 'ISLA',
        monto: amountToSettle,
        fecha: new Date(),
        reference: `Settled in ${islandName} (POS Bulk)`,
        status: 'PAID'
      });
    }

    // Update paymentMethod for summary views
    order.paymentMethod = `Isla: ${islandName}`;

    await order.save();
    return order;
  }

}
