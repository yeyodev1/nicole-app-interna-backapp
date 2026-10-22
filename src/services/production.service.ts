
import { OrderModel } from "../models/order.model";
import { getECDateRange, getEcuadorNow } from "../utils/date.utils";

export class ProductionService {
  /**
   * Returns production tasks (Orders), sorted by delivery date (urgency).
   */
  async getProductionTasks() {
    // 1. First, find candidate orders (active)
    const tasks = await OrderModel.find({
      productionStage: { $in: ["PENDING", "IN_PROCESS", "DELAYED"] }
    }).sort({ deliveryDate: 1 });

    // 2. Check for "Overtime" (DELAYED) status update
    const now = new Date();
    const updatedTasks = [];

    for (const task of tasks) {
      // If delivery date has passed and it's not finished, mark as DELAYED
      if (task.deliveryDate && task.deliveryDate < now && task.productionStage !== "DELAYED") {
        task.productionStage = "DELAYED";
        await task.save();
      }
      updatedTasks.push(task);
    }

    return updatedTasks;
  }

  /**
   * Returns a list of all active production orders with full details.
   * Useful for the tabular list view.
   */
  async getAllOrders(dateStr?: string, source?: 'nicole' | 'sucree') {
    let matchQuery: any;

    if (!dateStr || dateStr === 'today') {
      // Default: only today's orders in Ecuador time
      const ecNow = getEcuadorNow();
      const y = ecNow.getUTCFullYear();
      const m = String(ecNow.getUTCMonth() + 1).padStart(2, '0');
      const d = String(ecNow.getUTCDate()).padStart(2, '0');
      const { startDate, endDate } = getECDateRange(`${y}-${m}-${d}`, false);
      matchQuery = { deliveryDate: { $gte: startDate, $lte: endDate } };
    } else if (dateStr === 'all') {
      // Broad query: all active + recently sent (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      matchQuery = {
        // Ventas con link sin completar: todavía no tienen fecha ni entran a producción.
        productionStage: { $ne: "AWAITING_CLIENT" },
        $or: [
          { dispatchStatus: { $nin: ["SENT", "RETURNED"] } },
          { dispatchStatus: "SENT", deliveryDate: { $gte: sevenDaysAgo } }
        ]
      };
    } else {
      // Specific YYYY-MM-DD date
      const { startDate, endDate } = getECDateRange(dateStr, false);
      matchQuery = { deliveryDate: { $gte: startDate, $lte: endDate } };
    }

    if (source) {
      matchQuery.contificoSource = source;
    }

    const orders = await OrderModel.find(matchQuery).sort({ deliveryDate: 1 });

    // FIX: Auto-repair productionStage if inconsistent
    // If all products are fully produced but stage is PENDING/IN_PROCESS, mark as FINISHED
    // This solves the "disappearing orders" issue where items are 1/1 done but stage is stuck.
    for (const order of orders) {
      if (order.productionStage !== "FINISHED" && order.productionStage !== "VOID") {
        // Done = producido completo o cerrado (resto eliminado del pendiente)
        const allDone = order.products.every(
          p => (p.produced || 0) >= p.quantity || p.productionStatus === "COMPLETED"
        );
        if (allDone && order.products.length > 0) {
          order.productionStage = "FINISHED";
          await order.save();
        }
      }
    }

    return orders;
  }

  async updateTask(id: string, updates: { stage?: string; notes?: string }, user?: string) {
    const order = await OrderModel.findById(id);
    if (!order) return null;

    const oldStage = order.productionStage;
    if (updates.stage) order.productionStage = updates.stage as any;
    if (updates.notes !== undefined) order.productionNotes = updates.notes;

    // Audit Log for production stage change
    if (updates.stage && updates.stage !== oldStage) {
      order.auditLog.push({
        user: user || "Producción",
        action: "Etapa de Producción Actualizada",
        at: new Date(),
        details: `Pedido pasó de ${oldStage} a ${updates.stage}.`
      });
    }

    return await order.save();
  }

  /**
   * Batch update multiple tasks (e.g. mark all as FINISHED)
   */
  async batchUpdateTasks(ids: string[], updates: { stage?: string }) {
    const updateData: any = {};
    if (updates.stage) updateData.productionStage = updates.stage;

    // Update multiple documents
    return await OrderModel.updateMany(
      { _id: { $in: ids } },
      { $set: updateData }
    );
  }

  async getAggregatedItems(bucket?: 'delayed' | 'today' | 'tomorrow' | 'future', source?: 'nicole' | 'sucree') {
    // 0. Fetch Contifico Data (Categories & Products) for mapping
    // Ideally cached, but for now we fetch fresh or assume efficient enough
    const contificoService = new (require("./contifico.service").ContificoService)();

    let categoryMap = new Map<string, string>(); // CatID -> CatName
    let productCategoryMap = new Map<string, string>(); // ProdID -> CatName (or ProdName -> CatName if ID not sync)

    try {
      // Parallel Fetch with Caching
      const [categories, products] = await Promise.all([
        contificoService.getCachedCategories(),
        contificoService.getCachedProducts(2000) // Ensure we get enough
      ]);

      if (categories) {
        categories.forEach((c: any) => {
          categoryMap.set(c.id, c.nombre);
        });
      }

      // Map Products to Category Names based on Contifico ID
      if (products) {
        products.forEach((p: any) => {
          // Map by Contifico ID
          if (p.id) {
            const cName = categoryMap.get(p.categoria_id) || "OTROS";
            productCategoryMap.set(p.id, cName);
          }
          // Fallback: Map by Name (if local DB items don't have contifico_id populated)
          if (p.nombre) {
            const cName = categoryMap.get(p.categoria_id) || "OTROS";
            productCategoryMap.set(p.nombre.toLowerCase().trim(), cName);
          }
        });
      }

    } catch (err) {
      console.warn("⚠️ Failed to fetch Contifico metadata for categorization:", err);
    }

    // 1. Define Time Buckets (normalized to Ecuador UTC-5)
    const ecNow = getEcuadorNow();

    const toDayStr = (d: Date) => d.toISOString().split('T')[0];
    const todayStr = toDayStr(ecNow);

    const tomorrowDate = new Date(ecNow);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = toDayStr(tomorrowDate);

    // 2. Build Query based on Bucket
    // Base Match: Active Orders
    const baseMatch: any = {
      productionStage: { $in: ["PENDING", "IN_PROCESS", "DELAYED"] }
    };

    if (source) {
      baseMatch.contificoSource = source;
    }

    if (bucket) {
      // Apply Date Filter based on bucket
      // We assume stored deliveryDate is UTC correct or we compare strings?
      // Mongo stored dates are full ISO objects. 
      // Simple string comparison on YYYY-MM-DD works if we project, but for index efficiency we should use Date ranges.

      const { startDate: todayStart, endDate: todayEnd } = getECDateRange(todayStr, false);
      const { startDate: tomorrowStart, endDate: tomorrowEnd } = getECDateRange(tomorrowStr, false);

      // Adjust for Timezone offset if needed, but existing logic used simple string compare on output.
      // Let's stick to the string projection logic inside aggregate if we want perfect match with previous logic,
      // OR use range queries which are faster.
      // Given previous logic used `itemDayStr <= todayStr`, let's attempt to replicate that.

      if (bucket === 'delayed') {
        // < Today
        baseMatch.deliveryDate = { $lt: todayStart };
      } else if (bucket === 'today') {
        // >= TodayStart && <= TodayEnd
        baseMatch.deliveryDate = { $gte: todayStart, $lte: todayEnd };
      } else if (bucket === 'tomorrow') {
        // >= TomorrowStart && <= TomorrowEnd
        baseMatch.deliveryDate = { $gte: tomorrowStart, $lte: tomorrowEnd };
      } else if (bucket === 'future') {
        // > TomorrowEnd
        baseMatch.deliveryDate = { $gt: tomorrowEnd };
      }
    }

    // 3. Fetch flattened list of pending items
    const rawItems = await OrderModel.aggregate([
      {
        $match: baseMatch,
      },
      { $unwind: "$products" },
      {
        $match: {
          "products.productionStatus": { $ne: "COMPLETED" },
        },
      },
      {
        $addFields: {
          "products.produced": { $ifNull: ["$products.produced", 0] },
        },
      },
      {
        $addFields: {
          pendingQuantity: { $subtract: ["$products.quantity", "$products.produced"] },
        },
      },
      {
        $match: {
          pendingQuantity: { $gt: 0 },
        },
      },
      {
        $project: {
          // Flatten structure for easier JS processing
          productName: "$products.name",
          contificoId: "$products.contifico_id",
          totalInOrder: "$products.quantity",
          producedInOrder: "$products.produced",
          pendingInOrder: "$pendingQuantity",
          productionNotes: "$products.productionNotes",
          productionStatus: "$products.productionStatus",
          deliveryDate: "$deliveryDate",
          customerName: "$customerName",
          comments: "$comments",
          stage: "$productionStage",
          orderId: "$_id"
        }
      },
      { $sort: { deliveryDate: 1 } }
    ]);

    // 4. Mapping & Categorization Logic
    const mapCategory = (contificoName: string, productName: string): string | null => {
      const c = contificoName.toUpperCase();
      const p = productName.toUpperCase();

      // Exclude generic packaging/delivery/service items that are not "Produced"
      const EXCLUDE_PRODS = [
        'DELIVERY', 'FUNDA', 'VASO', 'TAPA', 'CUCHARA', 'TENEDOR', 'CUCHILLO',
        'SERVILLET', 'TUPPER', 'TAZON', 'TAZÓN', 'CEPO', 'LOGISTICA'
      ];

      if (EXCLUDE_PRODS.some(keyword => p.includes(keyword))) {
        return null;
      }

      if (c.includes('ENTEROS') || c.includes('TORTAS')) return 'cakes enteros';
      if (c.includes('PANADERIA')) return 'panaderais';
      if (c.includes('POSTRES') || c.includes('INDIVIDUAL')) return 'individual';

      // Specific Product overrides
      if (p.includes('TURRON')) return 'pack de turrones';
      if (p.includes('PANETTON')) return 'panetton';
      if (p.includes('SECOS') || p.includes('MARKET')) return 'secos market';
      if (p.includes('PORCION')) return 'cakes porcion';

      if (c === 'COMBOS' && !p.includes('DEGUSTA')) return null;

      return 'Otros';
    };

    const processedItems: any[] = [];

    for (const item of rawItems) {
      // Determine Category
      let rawCat = "OTROS";
      if (item.contificoId && productCategoryMap.has(item.contificoId)) {
        rawCat = productCategoryMap.get(item.contificoId)!;
      } else if (productCategoryMap.has(item.productName.toLowerCase().trim())) {
        rawCat = productCategoryMap.get(item.productName.toLowerCase().trim())!;
      }

      const mappedCat = mapCategory(rawCat, item.productName);

      if (mappedCat) {
        item.category = mappedCat;
        processedItems.push(item);
      }
    }

    // 5. Helper to group by Product Name
    const groupItems = (items: any[]) => {
      const groupedMap = new Map<string, any>();

      for (const item of items) {
        if (!groupedMap.has(item.productName)) {
          groupedMap.set(item.productName, {
            _id: item.productName,
            category: item.category, // Pass the category!
            totalQuantity: 0,
            urgency: item.deliveryDate,
            orders: []
          });
        }

        const group = groupedMap.get(item.productName);
        group.totalQuantity += item.pendingInOrder;
        group.orders.push({
          id: item.orderId,
          totalInOrder: item.totalInOrder,
          producedInOrder: item.producedInOrder,
          pendingInOrder: item.pendingInOrder,
          client: item.customerName,
          delivery: item.deliveryDate,
          stage: item.stage,
          notes: item.productionNotes,
          status: item.productionStatus,
          deliveryRound: item.comments || null
        });
      }
      return Array.from(groupedMap.values());
    };

    // 6. IF Bucket is specified, we just return that list (wrapped in the expected key or flat?)
    // To minimize frontend breakage, let's keep the return structure similar but only populate the requested key.

    if (bucket) {
      // Since we already filtered at DB level, ALL items belong to this bucket (mostly).
      // However, we should double check because date math is tricky.
      // Actually, since we want to be safe, we can just group everything.
      // Or if we trust the DB query, we just run groupItems(processedItems).

      const grouped = groupItems(processedItems);
      return {
        [bucket]: grouped
      };
    }

    // Default Behavior (No bucket): Do the manual splitting for everything (Backward Compatibility)
    const buckets = {
      todayItems: [] as any[],
      tomorrowItems: [] as any[],
      futureItems: [] as any[],
      delayedItems: [] as any[] // Explicitly track delayed if we want to separate from future? No, logic was specific.
    };

    // The logic below replicates the previous 'bucketizing' for the ALL case
    for (const item of processedItems) {
      const uDate = new Date(item.deliveryDate);
      const itemDayStr = toDayStr(uDate);

      // Note: Previous logic combined delayed into Today or handled it via sort?
      // "delayed" items usually have date < today.
      // Previous code: if (itemDayStr <= todayStr) -> buckets.todayItems
      // So 'delayed' was part of 'today' in the old code return value?
      // Wait, let's check the old code again.
      // Old code: if (itemDayStr <= todayStr) buckets.todayItems.push(item);
      // So YES, delayed items were returned under 'today'. 
      // BUT if we want to split them now, we should probably stick to the requested explicit split: Delayed, Today, Tomorrow, Future.

      if (itemDayStr < todayStr) {
        buckets.delayedItems.push(item);
      } else if (itemDayStr === todayStr) {
        buckets.todayItems.push(item);
      } else if (itemDayStr === tomorrowStr) {
        buckets.tomorrowItems.push(item);
      } else {
        buckets.futureItems.push(item);
      }
    }

    // Return all
    return {
      delayed: groupItems(buckets.delayedItems),
      today: groupItems(buckets.todayItems), // This now only has strictly TODAY items
      tomorrow: groupItems(buckets.tomorrowItems),
      future: groupItems(buckets.futureItems)
    };
  }

  async updateProductStatus(orderId: string, productName: string, status: "PENDING" | "IN_PROCESS" | "COMPLETED", notes?: string, user?: string) {
    const order = await OrderModel.findById(orderId);
    if (!order) return null;

    const product = order.products.find(p => p.name === productName);
    if (!product) return null;

    const oldStatus = product.productionStatus;
    if (status) product.productionStatus = status;
    if (notes !== undefined) product.productionNotes = notes;

    // Check if we should auto-update delivered/produced counts? 
    // If completed, maybe set produced = quantity?
    if (status === "COMPLETED") {
      product.produced = product.quantity;
    }

    // Recalculate Order Stage
    const oldOrderStage = order.productionStage;
    const allProductsDone = order.products.every(p => p.productionStatus === "COMPLETED" || (p.produced || 0) >= p.quantity);
    if (allProductsDone) {
      order.productionStage = "FINISHED";
    } else {
      // If at least one is in process or completed
      const anyAction = order.products.some(p => p.productionStatus !== "PENDING" || (p.produced || 0) > 0);
      if (anyAction && order.productionStage === "PENDING") {
        order.productionStage = "IN_PROCESS";
      }
    }

    // Audit Log for production progress
    if (status && status !== oldStatus) {
      order.auditLog.push({
        user: user || "Producción",
        action: "Estado de Producto Actualizado",
        at: new Date(),
        details: `${productName}: de ${oldStatus} a ${status}.`
      });
    }

    if (order.productionStage !== oldOrderStage) {
      order.auditLog.push({
        user: user || "Producción",
        action: "Etapa de Producción Actualizada",
        at: new Date(),
        details: `Pedido pasó de ${oldOrderStage} a ${order.productionStage} por avance en productos.`
      });
    }

    await order.save();
    return order;
  }

  /**
   * Register progress for a specific product type (e.g. "Made 10 Lemon Tarts").
   * Automatically distributes the produced amount to the oldest pending orders (FIFO).
   */
  async registerProductionProgress(
    productName: string,
    quantityMade: number,
    orderIds?: string[],
    discardRemainder?: boolean
  ) {
    let remainingToDistribute = quantityMade;
    let discarded = 0;

    // Find all active orders containing this product, sorted by urgency (deliveryDate ASC).
    // `orderIds` acota el reparto a los pedidos de la fila seleccionada en el resumen
    // (destino/ronda): así lo producido se acredita exactamente donde la cocina lo marcó.
    const query: any = {
      productionStage: { $in: ["PENDING", "IN_PROCESS", "DELAYED"] },
      "products.name": productName,
    };
    if (orderIds && orderIds.length > 0) {
      query._id = { $in: orderIds };
    }
    const orders = await OrderModel.find(query).sort({ deliveryDate: 1 });

    // "Eliminar el resto": si la cocina marca menos de lo pedido, lo que no se
    // hizo se saca del pendiente (productionStatus = COMPLETED con produced
    // menor a quantity) en vez de quedar colgado. Solo con orderIds para no
    // barrer pedidos fuera de la fila seleccionada.
    const applyDiscard = !!discardRemainder && !!orderIds && orderIds.length > 0;

    for (const order of orders) {
      if (remainingToDistribute <= 0 && !applyDiscard) break;

      let orderUpdated = false;

      // Iterate through products in the order to find the match
      for (const product of order.products) {
        if (product.name !== productName) continue;

        const currentProduced = product.produced || 0;
        const needed = product.quantity - currentProduced;

        if (needed > 0 && remainingToDistribute > 0) {
          const take = Math.min(needed, remainingToDistribute);
          product.produced = currentProduced + take;
          remainingToDistribute -= take;
          orderUpdated = true;
        }

        // Lo que quedó sin producir en esta fila se elimina del pendiente
        if (applyDiscard && (product.produced || 0) < product.quantity && product.productionStatus !== "COMPLETED") {
          discarded += product.quantity - (product.produced || 0);
          product.productionStatus = "COMPLETED";
          orderUpdated = true;
        }
      }

      if (orderUpdated) {
        // Done = producido completo o cerrado (resto eliminado)
        const allDone = order.products.every(
          (p) => (p.produced || 0) >= p.quantity || p.productionStatus === "COMPLETED"
        );

        if (allDone) {
          order.productionStage = "FINISHED";
        } else {
          // If started but not finished, ensure it's IN_PROCESS
          if (order.productionStage === "PENDING") {
            order.productionStage = "IN_PROCESS";
          }
        }

        order.markModified('products');
        await order.save();
      }
    }

    return {
      distributed: quantityMade - remainingToDistribute,
      remaining: remainingToDistribute, // If > 0, we made more than needed!
      discarded, // unidades que se eliminaron del pendiente
    };
  }

  async batchRegisterProductionProgress(
    items: { productName: string; quantity: number; orderIds?: string[]; discardRemainder?: boolean }[]
  ) {
    const results = [];
    for (const item of items) {
      try {
        const res = await this.registerProductionProgress(
          item.productName,
          item.quantity,
          item.orderIds,
          item.discardRemainder
        );
        results.push({ name: item.productName, success: true, data: res });
      } catch (err: any) {
        results.push({ name: item.productName, success: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Batch register dispatch for multiple orders.
   * Assumes full dispatch of remaining items for each order.
   */
  async batchRegisterDispatch(ids: string[], reportedBy: string) {
    let successCount = 0;
    let failedCount = 0;
    const errors: any[] = [];

    for (const id of ids) {
      try {
        const order = await OrderModel.findById(id);
        if (!order) continue;

        // Calculate what remains to be sent
        const dispatchItems = [];

        // Helper to calculate sent
        const sentMap = new Map<string, number>();
        if (order.dispatches) {
          for (const d of order.dispatches) {
            for (const item of d.items) {
              const cur = sentMap.get(item.productId) || 0;
              sentMap.set(item.productId, cur + item.quantitySent);
            }
          }
        }

        for (const product of order.products) {
          const sent = sentMap.get(product._id!.toString()) || 0;
          // El resto eliminado no se despacha: solo se debe lo producido
          const required = product.productionStatus === "COMPLETED"
            ? Math.min(product.quantity, product.produced || 0)
            : product.quantity;
          const remaining = required - sent;

          if (remaining > 0) {
            dispatchItems.push({
              productId: product._id,
              name: product.name,
              quantitySent: remaining,
              quantityReceived: 0
            });
          }
        }

        if (dispatchItems.length > 0) {
          const destination = order.deliveryType === 'delivery'
            ? 'Delivery'
            : (order.branch || 'Centro de Producción');

          const newDispatch: any = {
            reportedAt: new Date(),
            modifiedAt: new Date(),
            destination: destination,
            items: dispatchItems,
            notes: "Batch Dispatch (Auto)",
            reportedBy: reportedBy,
            receptionStatus: "PENDING"
          };

          order.dispatches.push(newDispatch);
          this.recalculateDispatchStatus(order);
          await order.save();
          successCount++;
        } else {
          // Already full, maybe just ensure status is SENT
          if (order.dispatchStatus !== 'SENT') {
            order.dispatchStatus = 'SENT';
            await order.save();
            successCount++; // Count as handled
          }
        }

      } catch (error: any) {
        failedCount++;
        errors.push({ id, error: error.message });
      }
    }

    return { success: successCount, failed: failedCount, errors };
  }

  /**
   * Register a new dispatch report for an order.
   */
  async registerDispatch(orderId: string, dispatchData: { destination: string; items: any[]; notes?: string; reportedBy: string }) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error("Order not found");

    const newDispatch: any = {
      reportedAt: new Date(),
      modifiedAt: new Date(),
      destination: dispatchData.destination,
      items: dispatchData.items,
      notes: dispatchData.notes,
      reportedBy: dispatchData.reportedBy
    };

    order.dispatches.push(newDispatch);

    // Audit Log for Dispatch
    order.auditLog.push({
      user: dispatchData.reportedBy || "Sistema",
      action: "Despacho Registrado",
      at: new Date(),
      details: `Despacho con destino a: ${dispatchData.destination}.`
    });

    // Recalculate global dispatch status
    this.recalculateDispatchStatus(order);

    return await order.save();
  }

  /**
   * Update an existing dispatch report.
   * Enforces 1-hour edit window.
   */
  async updateDispatch(orderId: string, dispatchId: string, updates: { items?: any[]; notes?: string }) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error("Order not found");

    const dispatch = (order.dispatches as any).id(dispatchId);
    if (!dispatch) throw new Error("Dispatch report not found");

    // 1-Hour Edit Window Validation
    const now = new Date();
    const reportedAt = new Date(dispatch.reportedAt);
    const diffHours = (now.getTime() - reportedAt.getTime()) / (1000 * 60 * 60);

    if (diffHours > 1) {
      throw new Error("Edit window expired (1 hour limit).");
    }

    // Apply updates
    if (updates.items) dispatch.items = updates.items;
    if (updates.notes !== undefined) dispatch.notes = updates.notes;
    dispatch.modifiedAt = now;

    // Recalculate Status
    this.recalculateDispatchStatus(order);

    // Audit Log for Dispatch Update
    order.auditLog.push({
      user: dispatch.reportedBy || "Sistema",
      action: "Despacho Actualizado",
      at: new Date(),
      details: `Se actualizaron datos del despacho a ${dispatch.destination}.`
    });

    return await order.save();
  }

  async getReportsStats(range: 'today' | 'week') {
    const ecNow = getEcuadorNow();
    const todayStr = ecNow.toISOString().split('T')[0];

    let query: any = {};

    if (range === 'today') {
      const { startDate, endDate } = getECDateRange(todayStr, false);
      query = {
        deliveryDate: {
          $gte: startDate,
          $lte: endDate
        }
      };
    } else {
      // Next 7 Days from EC Today
      const { startDate: start } = getECDateRange(todayStr, false);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      end.setUTCHours(23, 59, 59, 999);

      query = {
        deliveryDate: { $gte: start, $lte: end }
      };
    }

    const orders = await OrderModel.find(query).lean();

    // Aggregations
    const totalOrders = orders.length;
    let dispatchedCount = 0;
    let completedProductionCount = 0;

    const byDestination: Record<string, number> = {
      'San Marino': 0,
      'Mall del Sol': 0,
      'Centro de Producción': 0,
      'Delivery': 0
    };

    const byStatus: Record<string, number> = {
      'SENT': 0,
      'PARTIAL': 0,
      'NOT_SENT': 0,
      'PROBLEM': 0
    };

    for (const o of orders) {
      // Production Completion
      if (o.productionStage === 'FINISHED') completedProductionCount++;

      // Dispatch Status
      const status = o.dispatchStatus || 'NOT_SENT';
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (status === 'SENT' || status === 'PROBLEM') dispatchedCount++;

      // Destination
      if (o.deliveryType === 'delivery') {
        byDestination['Delivery']++;
      } else {
        const branch = o.branch || 'Centro de Producción';
        // Normalize branch names slightly if needed, or rely on frontend providing consistent names
        if (branch.toLowerCase().includes('marino')) byDestination['San Marino']++;
        else if (branch.toLowerCase().includes('mall') || branch.toLowerCase().includes('sol')) byDestination['Mall del Sol']++;
        else byDestination['Centro de Producción']++;
      }
    }

    return {
      kpis: {
        totalOrders,
        dispatchedCount,
        completedProductionCount,
        dispatchRate: totalOrders > 0 ? Math.round((dispatchedCount / totalOrders) * 100) : 0,
        productionRate: totalOrders > 0 ? Math.round((completedProductionCount / totalOrders) * 100) : 0
      },
      byDestination,
      byStatus
    };
  }

  private recalculateDispatchStatus(order: any) {
    if (!order.dispatches || order.dispatches.length === 0) {
      order.dispatchStatus = "NOT_SENT";
      return;
    }

    // Map total quantity sent per product
    const sentMap = new Map<string, number>();

    for (const dispatch of order.dispatches) {
      for (const item of dispatch.items) {
        const current = sentMap.get(item.productId) || 0;
        sentMap.set(item.productId, current + item.quantitySent);
      }
    }

    let status: "SENT" | "PARTIAL" | "PROBLEM" = "SENT";

    // Compare with ordered products
    for (const product of order.products) {
      const sent = sentMap.get(product._id.toString()) || 0;

      if (sent === 0) {
        status = "PARTIAL"; // At least one item not sent at all implies partial (if others are sent)
      } else if (sent < product.quantity) {
        status = "PARTIAL"; // Sent less than needed
      } else if (sent > product.quantity) {
        // Over-sending is a "PROBLEM" or special case, but strictly speaking it's "SENT" with excess.
        // For simple UI, let's mark it as PROBLEM if we want to alert, or SENT if lenient.
        // Requirement said: "indicate if sent excess". 
        status = "PROBLEM";
      }
    }

    // If completely empty map (handled by first check), but logic flow ensures we check all products.
    // Refined logic:
    // Start assuming everything matches.
    let allMatch = true;
    let anyDeficit = false;
    let anyExcess = false;
    let allZero = true;

    for (const product of order.products) {
      const sent = sentMap.get(product._id.toString()) || 0;
      if (sent > 0) allZero = false;

      // Resto eliminado del pedido: si el producto quedó cerrado produciendo
      // menos (productionStatus COMPLETED con produced < quantity), lo que se
      // debe enviar es lo producido, no la cantidad original. Así un pedido
      // con resto eliminado y todo lo producido enviado queda SENT, no PARTIAL.
      const required = product.productionStatus === "COMPLETED"
        ? Math.min(product.quantity, product.produced || 0)
        : product.quantity;

      if (sent < required) {
        allMatch = false;
        anyDeficit = true;
      } else if (sent > product.quantity) {
        allMatch = false;
        anyExcess = true;
      }
    }

    if (allZero) {
      order.dispatchStatus = "NOT_SENT";
    } else if (anyExcess) {
      order.dispatchStatus = "PROBLEM"; // Excess
    } else if (anyDeficit) {
      order.dispatchStatus = "PARTIAL";
    } else {
      order.dispatchStatus = "SENT"; // Perfect match
    }
  }

  /**
   * Register dispatch progress for multiple items for a specific destination.
   * Distributes the sent quantities to the oldest pending orders (FIFO).
   */
  async registerDispatchProgress(destination: string, items: { name: string; quantity: number }[]) {
    const results: any[] = [];

    // Filter Logic for Destination to find matching orders
    // We need to match how we categorize orders (Sales Channel / Delivery Type)
    // Destination comes from frontend: 'San Marino', 'Mall del Sol', 'Centro de Producción', 'Domicilio / Delivery'

    let query: any = {
      // We look for orders that represent demand. 
      // They could be in any production stage, but dispatch usually implies they are ready or being sent.
      // We generally want to fulfill orders that are NOT full 'SENT'.
      dispatchStatus: { $ne: 'SENT' },
      productionStage: { $ne: 'AWAITING_CLIENT' }
    };

    if (destination === 'Domicilio / Delivery') {
      query.deliveryType = 'delivery';
    } else {
      // Branch matching
      // We need flexible matching similar to stats or frontend
      if (destination.includes('Marino')) {
        query.branch = { $regex: /marino/i };
      } else if (destination.includes('Mall') || destination.includes('Sol')) {
        query.branch = { $regex: /(mall|sol)/i };
      } else if (destination.includes('Centro') || destination.includes('Producc')) {
        // Fallback or specific
        query.branch = { $regex: /(centro|producc)/i };
      }
      query.deliveryType = { $ne: 'delivery' };
    }

    // 1. Get Candidate Orders sorted by Date (FIFO)
    const orders = await OrderModel.find(query).sort({ deliveryDate: 1 });

    // 2. Process each reported item type
    for (const item of items) {
      let quantityToDistribute = item.quantity;
      let distributedCount = 0;

      for (const order of orders) {
        if (quantityToDistribute <= 0) break;

        // Check if order needs this item
        // Needs = Quantity Ordered - Quantity Already Sent

        // Calculate current sent for this specific item in this order
        let alreadySent = 0;
        if (order.dispatches && order.dispatches.length > 0) {
          for (const d of order.dispatches) {
            for (const dItem of d.items) {
              // Match by Name (since we are using product names here effectively)
              // Note: d.items usually stores { productId, name, quantitySent }
              if (dItem.name === item.name) {
                alreadySent += dItem.quantitySent;
              }
            }
          }
        }

        // Find the product definition in the order to get the target quantity
        const productDef = order.products.find(p => p.name === item.name);

        if (productDef) {
          // Validation: Can only dispatch what has been produced and not yet sent
          const produced = productDef.produced || 0;
          const alreadySentForProduct = alreadySent; // derived above

          // The "demand" is productDef.quantity
          // But the "capacity to receive dispatch" is limited by what is physically produced for this specific order
          // (Assuming 'produced' is tracked per-order, which it is in this model)

          const maxDispatchable = produced - alreadySentForProduct;

          // We also can't send more than the order requested obviously
          const needed = Math.min(productDef.quantity - alreadySentForProduct, maxDispatchable);

          if (needed > 0) {
            // We can allocate here
            const take = Math.min(needed, quantityToDistribute);

            // Create Dispatch Record for this Order
            const dispatchEntry: any = {
              reportedAt: new Date(),
              modifiedAt: new Date(),
              destination: destination,
              items: [{
                productId: productDef._id, // If available
                name: productDef.name,
                quantitySent: take
              }],
              notes: 'Auto-distributed from Mass Dispatch',
              reportedBy: 'Producción'
            };

            order.dispatches.push(dispatchEntry);

            // Update counters
            quantityToDistribute -= take;
            distributedCount += take;

            // Update Order Status immediately so next iteration knows (though we are in memory loop)
            this.recalculateDispatchStatus(order);

            // Explicitly mark modified to ensure array updates persist
            order.markModified('dispatches');
            await order.save();
          }
        }
      }

      results.push({
        item: item.name,
        requested: item.quantity,
        distributed: distributedCount,
        remaining: quantityToDistribute // Excess
      });
    }

    return results;
  }
  async voidOrder(orderId: string) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error("Order not found");

    order.productionStage = "VOID";
    order.voidedAt = new Date();
    return await order.save();
  }

  /**
   * Reverts a FINISHED order back to PENDING.
   * Resets all production progress for the items in the order.
   */
  async revertOrder(orderId: string) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error("Order not found");

    order.productionStage = "PENDING";

    // Reset all products to starting state
    order.products.forEach(p => {
      p.produced = 0;
      p.productionStatus = "PENDING";
    });

    order.markModified('products');
    return await order.save();
  }

  async restoreOrder(orderId: string) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error("Order not found");

    // 1-Hour Constraint Check
    if (order.productionStage === 'VOID' && order.voidedAt) {
      const now = new Date().getTime();
      const voidTime = new Date(order.voidedAt).getTime();
      const diffHours = (now - voidTime) / (1000 * 60 * 60);

      if (diffHours > 1) {
        throw new Error("Time limit exceeded. Voided orders can only be restored within 1 hour.");
      }
    }

    order.productionStage = "PENDING";
    order.voidedAt = null; // Clear timestamp

    // Reset product progress when restoring a voided order
    order.products.forEach(p => {
      p.produced = 0;
      p.productionStatus = "PENDING";
    });
    order.markModified('products');

    return await order.save();
  }

  /**
   * Marks an order as returned.
   * Resets dispatchStatus to NOT_SENT but keeps production status (since it's already made).
   * Appends a record to the notes.
   */
  async returnOrder(orderId: string, returnData: { notes: string; reportedBy: string }) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error("Order not found");

    // Reset dispatch status so it moves back to "Pending Dispatch" 
    // but keep productionStage as FINISHED/COMPLETED
    // UPDATE: Now setting to "RETURNED" to hide from production view completely.
    order.dispatchStatus = "RETURNED";

    const returnLog = `\n[DEVOLUCIÓN ${new Date().toLocaleString('es-EC')} por ${returnData.reportedBy}]: ${returnData.notes}`;
    order.comments = (order.comments || "") + returnLog;

    // Audit Log for Return
    order.auditLog.push({
      user: returnData.reportedBy || "Sistema",
      action: "Pedido Devuelto",
      at: new Date(),
      details: `Motivo: ${returnData.notes}`
    });

    return await order.save();
  }
}
