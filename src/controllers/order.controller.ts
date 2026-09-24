import { Request, Response, NextFunction } from "express";
import { CONTIFICO_CUENTA_BANCARIA_TRA } from "../config/contifico-cobro.config";
import { isPrecioIvaIncluido } from "../config/precio-final.config";
import { HttpStatusCode } from "axios";
import { models } from "../models";
import { ContificoService } from "../services/contifico.service";
import { getECDateRange } from "../utils/date.utils";
import { AuthRequest } from "../types/AuthRequest";
import { Types } from "mongoose";

const nicoleContificoService = new ContificoService('nicole');
const sucreeContificoService = new ContificoService('sucree');

/** Pick the right Contifico account based on the order's stored source. */
const getContificoService = (source?: string) =>
  source === 'sucree' ? sucreeContificoService : nicoleContificoService;

/**
 * Runs an invoice operation with the correct Contifico account.
 * If the service rejects with "no pertenece a la empresa" (wrong company),
 * auto-retries with the alternate service and persists the correct source on the order.
 */
async function withCorrectService<T>(
  orderId: string,
  storedSource: string | undefined,
  operation: (svc: ContificoService) => Promise<T>
): Promise<T> {
  const primarySvc = getContificoService(storedSource);
  try {
    return await operation(primarySvc);
  } catch (error: any) {
    const msg: string = error.message || String(error);
    if (msg.includes('no pertenece a la empresa')) {
      const alternateSvc = primarySvc.source === 'sucree' ? nicoleContificoService : sucreeContificoService;
      console.log(`ℹ️ [${orderId}] ${primarySvc.source} rechazó el documento, reintentando con ${alternateSvc.source}...`);
      const result = await operation(alternateSvc);
      // Persist the correct source so all future calls hit the right account
      await models.orders.findByIdAndUpdate(orderId, { contificoSource: alternateSvc.source });
      return result;
    }
    throw error;
  }
}

export async function createOrder(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const orderData = req.body;
    const jwtUser = req.user;

    // Fetch fresh user to avoid stale JWT issues
    let currentUser: any = jwtUser;
    if (jwtUser?.email) {
      currentUser = await models.users.findOne({ email: jwtUser.email }).lean() || jwtUser;
    }
    const currentRole = currentUser?.role?.toUpperCase();

    // Auto-populate responsible from logged-in user
    if (currentUser && (currentRole === 'SALES_REP' || currentRole === 'SALES_MANAGER' || currentRole === 'SALES')) {
      orderData.responsible = currentUser.name;
    }

    if (!orderData.responsible && currentUser) {
      orderData.responsible = currentUser.name || currentUser.email;
    }

    // Fallback if no user (should not happen with authMiddleware)
    if (!orderData.responsible) orderData.responsible = "Web";

    // Audit Fields
    orderData.createdBy = currentUser?.name || currentUser?.email || "Web";
    orderData.updatedBy = orderData.createdBy;
    orderData.auditLog = [{
      user: orderData.createdBy,
      action: "Pedido Creado",
      at: new Date(),
      details: "Creación inicial del pedido."
    }];

    // 1. Basic Validation
    if (!orderData.customerName || !orderData.products || orderData.products.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Customer name and products are required.",
      });
      return;
    }

    if (!orderData.deliveryTime) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Delivery time is required.",
      });
      return;
    }

    // Map deliveryType legacy check
    if (orderData.deliveryType === "pickup") {
      orderData.deliveryType = "retiro";
    }

    // STRICT VALIDATION: Delivery Requirements
    if (orderData.deliveryType === "delivery") {
      if (!orderData.googleMapsLink || !orderData.deliveryAddress) {
        res.status(HttpStatusCode.BadRequest).send({
          message: "For Delivery orders, Google Maps Link and Delivery Address are mandatory.",
        });
        return;
      }
    }

    // Persist the Contifico source from the cart products so invoice generation
    // always uses the right account (Nicole vs Sucree).
    const firstProductSource = orderData.products?.[0]?.source;
    orderData.contificoSource = firstProductSource === 'sucree' ? 'sucree' : 'nicole';

    // Vendedor a cargo: la cédula manda. El nombre se toma del catálogo para que
    // coincida exacto con la persona en Contífico (de ahí sale la comisión).
    const sellerIdentification = String(orderData.sellerIdentification || "").replace(/\D/g, "");
    if (sellerIdentification) {
      const seller = await models.sellers.findOne({
        contificoSource: orderData.contificoSource,
        identification: sellerIdentification,
        isActive: true,
      });
      if (!seller) {
        res.status(HttpStatusCode.BadRequest).send({
          message: `Vendedor con cédula ${sellerIdentification} no está en el catálogo activo.`,
        });
        return;
      }
      orderData.sellerIdentification = seller.identification;
      orderData.sellerName = seller.name;
    } else {
      delete orderData.sellerIdentification;
      delete orderData.sellerName;
    }

    // Default defaults
    if (!orderData.orderDate) orderData.orderDate = new Date();
    if (!orderData.salesChannel) orderData.salesChannel = "Web";
    if (!orderData.paymentMethod) orderData.paymentMethod = "Por confirmar";

    // Si es retiro directo de tienda, marcar como finalizado en producción
    if (orderData.skipProduction === true) {
      orderData.productionStage = "FINISHED";
    }

    // Handle Settlement in Island during creation
    if (orderData.settledInIsland && orderData.settledIslandName) {
      orderData.paymentMethod = `Isla: ${orderData.settledIslandName}`;
      orderData.paymentDetails = {
        forma_cobro: 'ISLA',
        monto: orderData.totalValue || 0,
        fecha: new Date().toISOString().split('T')[0],
        numero_comprobante: `ISLA-${orderData.settledIslandName}`
      };
    }

    // Banco de destino de las transferencias: siempre el mismo. Se fija aquí
    // para que el pedido quede guardado con la cuenta real, y no en blanco
    // como quedaba cuando el vendedor no escribía nada.
    if (orderData.paymentDetails?.forma_cobro === 'TRA') {
      orderData.paymentDetails.cuenta_bancaria_id = CONTIFICO_CUENTA_BANCARIA_TRA;
    }

    // Initialize payments array if paymentDetails is present
    if (orderData.paymentDetails && orderData.paymentDetails.monto > 0) {
      orderData.payments = [{
        ...orderData.paymentDetails,
        fecha: new Date(),
        status: 'PAID'
      }];
    } else {
      orderData.payments = [];
    }

    // Calculate totalValue if missing
    if (orderData.totalValue === undefined || orderData.totalValue === null) {
      if (orderData.isGlobalCourtesy) {
        orderData.totalValue = 0;
      } else {
        const subtotal = orderData.products.reduce((sum: number, p: any) => {
          let discount = p.isCourtesy ? 100 : 0;
          if (orderData.globalDiscountPercentage > 0 && discount < 100) {
            discount = orderData.globalDiscountPercentage;
          }
          const itemTotal = (Number(p.price) * Number(p.quantity)) * ((100 - discount) / 100);
          return sum + itemTotal;
        }, 0);

        const iva = orderData.products.reduce((sum: number, p: any) => {
          let discount = p.isCourtesy ? 100 : 0;
          if (orderData.globalDiscountPercentage > 0 && discount < 100) {
            discount = orderData.globalDiscountPercentage;
          }
          // El precio de delivery y de la Torta Personalizada ya trae el IVA dentro,
          // así que no se le suma nada encima (ver precio-final.config.ts).
          if (isPrecioIvaIncluido(p)) return sum;

          const itemTotal = (Number(p.price) * Number(p.quantity)) * ((100 - discount) / 100);
          return sum + (itemTotal * 0.15);
        }, 0);

        orderData.totalValue = Number((subtotal + iva).toFixed(2));
      }
    }

    // Auto-populate deliveryValue if it's 0 but there's a "Delivery" product
    if (!orderData.deliveryValue || orderData.deliveryValue === 0) {
      const deliveryProduct = orderData.products.find((p: any) =>
        p.name.toLowerCase().includes("delivery") || p.name.toLowerCase().includes("envío")
      );
      if (deliveryProduct) {
        orderData.deliveryValue = Number(deliveryProduct.price) * Number(deliveryProduct.quantity);
        // Also ensure deliveryType is set to delivery if we found a delivery fee
        if (orderData.deliveryType !== "delivery") {
          orderData.deliveryType = "delivery";
        }
      }
    }

    // 2. Save Order to Database
    const newOrder = new models.orders(orderData);
    await newOrder.save();

    // 3. Generate WhatsApp Message (Strict Format)
    /*
      CONFIRMACIÓN DE PEDIDO - NICOLE PASTRY
      Tipo de Orden: [Ej: Delivery saliendo de Ceibos]
      Cliente: [Nombre]
      Cédula/RUC: [Dato]
      Correo: [Dato]
      Celular: [Dato]
      Fecha de Entrega: [DD/MM/AAAA]
      Hora de Entrega/Retiro: [Hora solicitada por cliente]
      Items (Nombre Contífico):
      [Cantidad] x [Nombre Exacto en Contífico]
      Dirección de Entrega: [Texto]
      Link Maps: [Pegar Link Aquí]
    */

    const productsString = orderData.products
      .map((p: any) => `${p.quantity} x ${p.name}`)
      .join("\n");

    const deliveryDateFormatted = new Date(orderData.deliveryDate).toLocaleDateString('es-EC');

    // Construct "Type of Order" string
    // e.g. "Delivery saliendo de Ceibos" or "Retiro en local - San Marino"
    let typeOfOrder = "";
    if (orderData.skipProduction) {
      typeOfOrder = `Retiro directo de tienda - ${orderData.exitPoint || orderData.branch || 'S/N'}`;
    } else if (orderData.deliveryType === 'retiro') {
      typeOfOrder = `Retiro en local - ${orderData.branch || 'S/N'}`;
    } else {
      typeOfOrder = `Delivery saliendo de - ${orderData.branch || 'S/N'}`;
    }

    const whatsappMessage = `
CONFIRMACIÓN DE PEDIDO - NICOLE PASTRY

Tipo de Orden: ${typeOfOrder}

Cliente: ${orderData.customerName}

Cédula/RUC: ${orderData.invoiceData?.ruc || "N/A"}

Correo: ${orderData.invoiceData?.email || "N/A"}

Celular: ${orderData.customerPhone}

Fecha de Entrega: ${deliveryDateFormatted}

Hora de Entrega/Retiro: ${orderData.deliveryTime}

Items (Nombre Contífico):

${productsString}

Dirección de Entrega: ${orderData.deliveryType === 'delivery' ? orderData.deliveryAddress : 'N/A (Retiro)'}

Link Maps: ${orderData.googleMapsLink || 'N/A'}

Motorizado: ${orderData.deliveryPerson?.name || 'Por asignar'}
Valor Envío: $${orderData.deliveryValue || 0}
    `.trim();

    // 4. Send Response
    res.status(HttpStatusCode.Created).send({
      message: "Order created successfully.",
      order: newOrder,
      whatsappMessage
    });
    return;
  } catch (error) {
    console.error("❌ Error in createOrder:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error occurred while creating order.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Get all orders with optional filtering
 */
export async function getOrders(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { search, startDate, endDate } = req.query;
    const jwtUser = req.user;

    // Fetch fresh user to avoid stale JWT issues
    let currentUser: any = jwtUser;
    if (jwtUser?.email) {
      currentUser = await models.users.findOne({ email: jwtUser.email }).lean() || jwtUser;
    }
    const currentRole = currentUser?.role?.toUpperCase();

    const query: any = {};

    // Pedidos de la tienda online por gestionar (status PENDIENTE_GESTION).
    const webPending = req.query.webPending === 'true';

    // Data Isolation for Sales Reps
    // Excepción: los pedidos web pendientes no tienen vendedor (responsible = "Tienda Online"),
    // así que cualquier vendedor debe poder verlos para tomarlos.
    if (currentUser && (currentRole === 'SALES_REP' || currentRole === 'SALES') && !webPending) {
      if (currentUser.name) {
        query.responsible = { $regex: new RegExp(`^${currentUser.name}$`, "i") };
      }
    }

    // 1. Search Filter (Name, RUC, Email)
    if (search) {
      const searchRegex = new RegExp(String(search), 'i');
      query.$or = [
        { customerName: searchRegex },
        { "invoiceData.ruc": searchRegex },
        { "invoiceData.email": searchRegex }
      ];
    }

    // Date Filters
    if (startDate || endDate) {
      const dateType = req.query.dateType as string;
      const dateField = dateType === 'createdAt' ? 'createdAt' : 'deliveryDate';
      const isFullTimestamp = dateField === 'createdAt';
      query[dateField] = {};

      if (startDate) {
        const s = String(startDate);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          const { startDate: startRange } = getECDateRange(s, isFullTimestamp);
          query[dateField].$gte = startRange;
        } else {
          query[dateField].$gte = new Date(s);
        }
      }
      if (endDate) {
        const e = String(endDate);
        if (/^\d{4}-\d{2}-\d{2}$/.test(e)) {
          const { endDate: endRange } = getECDateRange(e, isFullTimestamp);
          query[dateField].$lte = endRange;
        } else {
          const eDate = new Date(e);
          eDate.setHours(23, 59, 59, 999);
          query[dateField].$lte = eDate;
        }
      }
    }

    // 3. Invoice Status Filter (ERROR, PENDING, PROCESSED)
    if (req.query.invoiceStatus) {
      if (req.query.invoiceStatus === 'UNBILLED') {
        query.invoiceStatus = { $ne: 'PROCESSED' };
      } else {
        query.invoiceStatus = req.query.invoiceStatus;
      }
    }

    // 4. Dispatch Status Filter (e.g. RETURNED)
    if (req.query.dispatchStatus) {
      query.dispatchStatus = req.query.dispatchStatus;
    }

    // 5. Tienda online: pendientes de gestionar y filtro por canal de venta
    if (webPending) {
      query.status = 'PENDIENTE_GESTION';
    }
    if (typeof req.query.salesChannel === 'string' && req.query.salesChannel) {
      query.salesChannel = req.query.salesChannel;
    }

    // 3. Execution
    // If we have filters, we might want to return more than 100, or just default to a larger number.
    // For now, let's keep a limit but make it larger if searching.
    const limit = (search || startDate || endDate) ? 500 : 100;
    const sortField = req.query.dateType === 'createdAt' ? 'createdAt' : 'deliveryDate';

    const orders = await models.orders
      .find(query)
      .sort({ [sortField]: -1, createdAt: -1 }) // Sort by selected date field primarily
      .limit(limit);

    res.status(HttpStatusCode.Ok).send(orders);
    return;
  } catch (error) {
    console.error("❌ Error in getOrders:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error while fetching orders.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Get single order by ID
 */
export async function getOrderById(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found" });
      return;
    }

    res.status(HttpStatusCode.Ok).send(order);
    return;
  } catch (error) {
    console.error("❌ Error in getOrderById:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error while fetching order.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Get invoice processing status (counts of pending and error orders)
 * GET /api/orders/invoice-status
 */
export async function getInvoiceStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const [pending, error, processed, errorOrders] = await Promise.all([
      models.orders.countDocuments({ invoiceNeeded: true, invoiceStatus: "PENDING" }),
      models.orders.countDocuments({ invoiceNeeded: true, invoiceStatus: "ERROR" }),
      models.orders.countDocuments({ invoiceStatus: "PROCESSED" }),
      models.orders.find(
        { invoiceNeeded: true, invoiceStatus: "ERROR" },
        { _id: 1, customerName: 1, invoiceError: 1, invoiceData: 1, deliveryDate: 1 }
      ).sort({ updatedAt: -1 }).limit(50).lean(),
    ]);

    res.status(HttpStatusCode.Ok).send({ pending, error, processed, errorOrders });
    return;
  } catch (err) {
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error fetching invoice status" });
    return;
  }
}

/**
 * Process all pending (and errored) invoices
 * Called by GitHub Actions cron — protected by CRON_SECRET
 */
export async function processPendingInvoices(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // ── Auth: validate CRON_SECRET ──────────────────────────────────────────
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== cronSecret) {
        res.status(HttpStatusCode.Unauthorized).send({ message: "Unauthorized." });
        return;
      }
    }

    // ── Batch config ────────────────────────────────────────────────────────
    // Process PENDING first, then ERROR (retries). 5 orders per batch.
    const BATCH_SIZE = 5;

    // Count actionable orders: PENDING + ERROR
    const totalPending = await models.orders.countDocuments({
      invoiceNeeded: true,
      invoiceStatus: { $in: ["PENDING", "ERROR"] }
    });

    if (totalPending === 0) {
      res.status(HttpStatusCode.Ok).send({ message: "No pending invoices found.", remaining: 0 });
      return;
    }

    // PENDING orders take priority over ERROR retries
    const pendingOrders = await models.orders.find({
      invoiceNeeded: true,
      invoiceStatus: { $in: ["PENDING", "ERROR"] }
    })
      .sort({ invoiceStatus: -1 }) // "PENDING" > "ERROR" alphabetically → PENDING first
      .limit(BATCH_SIZE);


    const results = {
      processed: 0,
      failed: 0,
      errors: [] as any[]
    };

    for (const order of pendingOrders) {
      try {

        // 1. Ensure client exists or create it (handled by logic if needed, but assuming data is ready)
        // Note: ContificoService.createInvoice creates the client if needed implicitly via the payload structure? 
        // Actually earlier we modified createPerson, but createInvoice also sends client data.

        // 2. Create Invoice
        const orderSvc = getContificoService((order as any).contificoSource);
        const invoiceResponse = await orderSvc.createInvoice(order);

        // 3. Update Order
        if (invoiceResponse.error) {
          const errorMsg = typeof invoiceResponse.error === 'object'
            ? JSON.stringify(invoiceResponse.error)
            : String(invoiceResponse.error);
          throw new Error(errorMsg);
        }

        order.invoiceStatus = "PROCESSED";
        order.invoiceInfo = invoiceResponse;
        await order.save();

        // 3.1 Trigger SRI Authorization y registrar timestamp
        // sendToSriWhenReady espera a que Contifico termine de firmar antes de enviar al SRI
        order.invoiceSentToSriAt = new Date();
        await order.save();
        orderSvc.sendToSriWhenReady(invoiceResponse.id)
          .catch(sriError => console.warn(`⚠️ Failed to trigger SRI for order ${order._id} (non-blocking)`, sriError));

        // 4. Register Collection AUTOMATICALLY if payment details exist
        // SKIP if it's Credit (CR)
        if (order.paymentDetails && order.paymentDetails.monto && order.paymentDetails.forma_cobro !== 'CR') {
          try {

            // El banco de destino lo fija registerCollection, y sólo para
            // transferencias — aquí no corresponde imponerlo.
            const collectionPayload = {
              ...order.paymentDetails,
              monto: invoiceResponse.total, // FORCE MATCH: Pay exactly what the invoice says
            };

            await orderSvc.registerCollection(invoiceResponse.id, collectionPayload);
          } catch (collectionError: any) {
            console.error(`⚠️ Failed to register automatic collection for order ${order._id}:`, collectionError.message);
            // We don't fail the invoice process, just log it. 
            // Ideally we might want to flag the order as "INVOICED_BUT_PAYMENT_FAILED" or similar.
            // For now, logging is sufficient as admin can retry manually via UI.
          }
        }

        results.processed++;
      } catch (error: any) {
        console.error(`❌ Failed to invoice order ${order._id}:`, error.message);
        order.invoiceStatus = "ERROR";
        order.invoiceError = error.message;
        await order.save();

        results.failed++;
        results.errors.push({
          orderId: order._id,
          error: error.message
        });
      }
    }

    // Re-count remaining after processing (accurate for loop control)
    const remaining = await models.orders.countDocuments({
      invoiceNeeded: true,
      invoiceStatus: { $in: ["PENDING", "ERROR"] }
    });

    console.log(`[batch-invoice] Batch done. Processed: ${results.processed}, Failed: ${results.failed}, Remaining: ${remaining}`);

    res.status(HttpStatusCode.Ok).send({
      message: `Batch processed. ${remaining} invoices remaining.`,
      results,
      remaining,
      totalPending
    });
    return;

  } catch (error) {
    console.error("❌ Error in processPendingInvoices:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error during batch processing.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Update invoice data for an existing order
 * Allowed only if invoiceStatus is 'PENDING'
 */
export async function updateInvoiceData(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { invoiceNeeded, invoiceData } = req.body;

    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    // Bloquear edición solo si la factura ya está AUTORIZADA por el SRI.
    // Si está PROCESSED pero no autorizada (firmado=false, autorizacion=null), permitir edición
    // para que el usuario pueda corregir datos y luego regenerar.
    const invoiceInfo = order.invoiceInfo as any;
    // autorizacion="" es el valor inicial de Contifico (no autorizada) — solo bloquear con valor real
    const isAuthorized = !!(invoiceInfo?.autorizacion);
    if (order.invoiceStatus === "PROCESSED" && isAuthorized) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "No se pueden editar los datos de facturación: la factura ya fue autorizada por el SRI."
      });
      return;
    }

    // Update fields — sanitize RUC/cedula: strip all spaces before saving
    if (invoiceNeeded !== undefined) order.invoiceNeeded = invoiceNeeded;
    if (invoiceData) {
      if (invoiceData.ruc) invoiceData.ruc = invoiceData.ruc.replace(/\s+/g, "");
      order.invoiceData = invoiceData;
    }

    // Reset status to PENDING if it was ERROR, so it gets picked up again
    if (order.invoiceNeeded) {
      order.invoiceStatus = "PENDING";
      order.invoiceError = undefined; // Clear previous error when data is corrected
    } else {
      order.invoiceStatus = undefined;
      order.invoiceError = undefined;
    }

    await order.save();

    res.status(HttpStatusCode.Ok).send({
      message: "Order invoice data updated successfully.",
      order
    });
    return;
  } catch (error) {
    console.error("❌ Error in updateInvoiceData:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error while updating order.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Update an existing order (Generic)
 * PUT /api/orders/:id
 */
export async function updateOrder(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const currentUser = req.user;

    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    // Update recursively or specifically
    if (updateData.deliveryPerson) order.deliveryPerson = updateData.deliveryPerson;
    if (updateData.deliveryValue !== undefined) order.deliveryValue = updateData.deliveryValue;
    if (updateData.deliveryType) order.deliveryType = updateData.deliveryType;
    if (updateData.branch) order.branch = updateData.branch;
    if (updateData.comments) order.comments = updateData.comments;
    if (updateData.customerName) order.customerName = updateData.customerName;
    if (updateData.customerPhone) order.customerPhone = updateData.customerPhone;
    if (updateData.deliveryAddress) order.deliveryAddress = updateData.deliveryAddress;
    if (updateData.googleMapsLink) order.googleMapsLink = updateData.googleMapsLink;

    // Fix: Missing Date Fields
    if (updateData.deliveryDate) order.deliveryDate = updateData.deliveryDate;
    if (updateData.deliveryTime) order.deliveryTime = updateData.deliveryTime;
    if (updateData.orderDate) order.orderDate = updateData.orderDate;


    // NEW: Allow updating core order data (products, payments)
    if (updateData.products) order.products = updateData.products;
    if (updateData.totalValue !== undefined) order.totalValue = updateData.totalValue;

    // Payment updates
    if (updateData.paymentDetails) order.paymentDetails = updateData.paymentDetails;
    if (updateData.payments) order.payments = updateData.payments;
    if (updateData.paymentMethod) order.paymentMethod = updateData.paymentMethod;

    // Invoice Data updates (if not processed)
    if (order.invoiceStatus !== 'PROCESSED') {
      if (updateData.invoiceNeeded !== undefined) order.invoiceNeeded = updateData.invoiceNeeded;
      if (updateData.invoiceData) order.invoiceData = updateData.invoiceData;
    }

    // Settlement updates
    if (updateData.settledInIsland !== undefined) order.settledInIsland = updateData.settledInIsland;
    if (updateData.settledIslandName) order.settledIslandName = updateData.settledIslandName;

    // Vendedor a cargo — sólo mientras la factura no se haya emitido: después el
    // documento ya vive en Contífico con su vendedor y cambiarlo aquí no lo mueve.
    if (updateData.sellerIdentification !== undefined && order.invoiceStatus !== 'PROCESSED') {
      const nextIdentification = String(updateData.sellerIdentification || "").replace(/\D/g, "");
      if (!nextIdentification) {
        order.sellerIdentification = undefined;
        order.sellerName = undefined;
      } else {
        const seller = await models.sellers.findOne({
          contificoSource: (order as any).contificoSource || 'nicole',
          identification: nextIdentification,
          isActive: true,
        });
        if (!seller) {
          res.status(HttpStatusCode.BadRequest).send({
            message: `Vendedor con cédula ${nextIdentification} no está en el catálogo activo.`,
          });
          return;
        }
        order.sellerIdentification = seller.identification;
        order.sellerName = seller.name;
      }
    }

    // Audit for update
    if (currentUser) {
      order.updatedBy = currentUser.name || currentUser.email;
      order.auditLog.push({
        user: order.updatedBy,
        action: "Pedido Actualizado",
        at: new Date(),
        details: "Se actualizaron campos del pedido."
      });
    }

    await order.save();

    res.status(HttpStatusCode.Ok).send({
      message: "Order updated successfully.",
      order
    });
    return;
  } catch (error) {
    console.error("❌ Error in updateOrder:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error while updating order.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Marca un pedido de la tienda online como gestionado por el equipo.
 * PATCH /api/orders/:id/web-managed
 */
export async function markWebOrderManaged(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(String(id))) {
      res.status(HttpStatusCode.NotFound).send({ message: "Pedido no encontrado." });
      return;
    }

    const order = await models.orders.findById(id);
    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Pedido no encontrado." });
      return;
    }
    if (!order.webOrder?.externalId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Este pedido no viene de la tienda online." });
      return;
    }
    if (order.status === 'GESTIONADO') {
      res.status(HttpStatusCode.Ok).send({ message: "El pedido ya estaba gestionado.", order });
      return;
    }

    const userName = req.user?.name || req.user?.email || "Usuario";
    const now = new Date();
    order.status = 'GESTIONADO';
    order.webOrder.managedAt = now;
    order.webOrder.managedBy = userName;
    order.markModified('webOrder');
    order.updatedBy = userName;
    order.auditLog.push({
      user: userName,
      action: "Pedido web gestionado",
      at: now,
      details: `Pedido web ${order.webOrder.code || order.webOrder.externalId} marcado como gestionado.`,
    });
    await order.save();

    res.status(HttpStatusCode.Ok).send({ message: "Pedido marcado como gestionado.", order });
    return;
  } catch (error) {
    console.error("❌ Error in markWebOrderManaged:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error interno al marcar el pedido como gestionado.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Register a collection (cobro) for an order
 * POST /api/orders/:id/collection
 */
export async function registerCollection(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const collectionData = req.body;

    // 1. Validate Order
    const order = await models.orders.findById(id);
    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    // 2. Validate Payment Overflows
    // 2. Validate Payment Overflows
    const currentPaid = (order.payments || []).reduce((sum, p) => sum + (p.monto || 0), 0);
    const newAmount = Number(collectionData.monto);

    // SELF-HEALING: If totalValue is 0 (legacy/bug), recalculate from products
    let effectiveTotal = order.totalValue;
    if (!effectiveTotal || effectiveTotal === 0) {
      effectiveTotal = order.products.reduce((sum: number, p: any) => {
        if (p.isCourtesy) return sum;
        return sum + (Number(p.price) * Number(p.quantity));
      }, 0);

      if (effectiveTotal > 0) {
        order.totalValue = effectiveTotal;
        // Will be saved below with order.save()
      }
    }

    // Allow small Floating Point tolerance
    if ((currentPaid + newAmount) > (effectiveTotal + 0.10)) { // 10 cents tolerance
      res.status(HttpStatusCode.BadRequest).send({
        message: `Payment exceeds total order value. Total: ${effectiveTotal}, Paid: ${currentPaid}, Attempting: ${newAmount}`
      });
      return;
    }

    // 3. Banco de destino: las transferencias siempre entran a la misma cuenta.
    // El vendedor ya no elige banco, así que se fija aquí y queda registrado
    // igual en el pedido y en Contífico.
    if (collectionData.forma_cobro === 'TRA') {
      collectionData.cuenta_bancaria_id = CONTIFICO_CUENTA_BANCARIA_TRA;
    }

    // Update Legacy Field (Last Payment)
    if (!order.paymentDetails) order.paymentDetails = {} as any;
    order.paymentDetails = {
      ...order.paymentDetails,
      ...collectionData
    };

    // Push to Payments Array
    if (!order.payments) order.payments = [];
    order.payments.push({
      ...collectionData,
      fecha: new Date(),
      status: 'PAID'
    });

    // Audit Log for Payment
    if (req.user) {
      order.auditLog.push({
        user: req.user.name || req.user.email,
        action: "Pago Registrado",
        at: new Date(),
        details: `Se registró un pago de $${collectionData.monto} via ${collectionData.forma_cobro}.`
      });
    }

    // Also update top-level paymentMethod string if coming from UI mapping
    if (collectionData.forma_cobro) {
      // Map code to label for display
      const methodMap: any = { 'TRA': 'Transferencia', 'TC': 'Tarjeta', 'CR': 'Crédito' };
      // Only update if it's the first payment or explicit override? 
      // Let's just update the label to reflect the latest method used.
      order.paymentMethod = methodMap[collectionData.forma_cobro] || order.paymentMethod;
    }

    await order.save();

    // 4. Check Invoice Existence
    const documentId = order.invoiceInfo?.id;

    if (!documentId) {
      // Offline/Queued Mode
      // Ensure invoiceNeeded is true so batch picks it up
      if (!order.invoiceNeeded) {
        order.invoiceNeeded = true;
        order.invoiceStatus = "PENDING";
        await order.save();
      }

      res.status(HttpStatusCode.Ok).send({
        message: "Payment registered locally. Will be synced to Contífico when invoice is generated.",
        localOnly: true,
        order
      });
      return;
    }

    // 5. Register Collection in Contífico (Immediate Mode)
    // SKIP Contífico for Credit payments (CR)
    if (collectionData.forma_cobro === 'CR') {
      res.status(HttpStatusCode.Created).send({
        message: "Payment registered as Credit (Internal).",
        localOnly: true,
        order
      });
      return;
    }

    const payloadToSend = {
      ...collectionData,
      cuenta_bancaria_id: collectionData.cuenta_bancaria_id
    };

    const result = await withCorrectService(
      id,
      (order as any).contificoSource,
      svc => svc.registerCollection(documentId, payloadToSend)
    );

    res.status(HttpStatusCode.Created).send({
      message: "Collection registered successfully in Contífico.",
      result,
      order
    });

  } catch (error: any) {
    console.error("❌ Error registering collection:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Failed to register collection.",
      error: error.message || String(error)
    });
  }
}



/**
 * Manually trigger invoice generation for a specific order
 * POST /api/orders/:id/invoice/generate
 */
export async function generateInvoice(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    if (order.invoiceStatus === "PROCESSED") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invoice already processed." });
      return;
    }

    if (!order.invoiceNeeded) {
      order.invoiceNeeded = true;
    }


    // Create Invoice — use the Contifico account that matches the order's products.
    // If Contifico rejects with "no pertenece a la empresa", the stored source is wrong
    // (e.g. legacy order without contificoSource, or products from the other brand).
    // Auto-retry with the alternate service and persist the correct source.
    let svc = getContificoService((order as any).contificoSource);
    let invoiceResponse = await svc.createInvoice(order);

    const isWrongCompanyError = (resp: any) => {
      const msg = typeof resp?.error === 'object'
        ? (resp.error?.mensaje || JSON.stringify(resp.error))
        : String(resp?.error || '');
      return msg.includes('no pertenece a la empresa');
    };

    if (invoiceResponse.error && isWrongCompanyError(invoiceResponse)) {
      // The current service doesn't own these products — flip to the other account.
      const alternateSvc = svc.source === 'sucree' ? nicoleContificoService : sucreeContificoService;
      const alternateSource = alternateSvc.source;
      console.log(`ℹ️ Order ${id}: ${svc.source} rejected product IDs, retrying with ${alternateSource}...`);
      svc = alternateSvc;
      invoiceResponse = await svc.createInvoice(order);
      if (!invoiceResponse.error) {
        // Persist correct source so future operations (SRI, PDF, collection) use the right account
        await models.orders.findByIdAndUpdate(id, { contificoSource: alternateSource });
      }
    }

    if (invoiceResponse.error) {
      // Extract human-readable message from Contifico's error response
      let contificoMensaje = '';
      const rawError = invoiceResponse.error;

      if (typeof rawError === 'object' && rawError !== null) {
        contificoMensaje = rawError.mensaje || JSON.stringify(rawError);
      } else if (typeof rawError === 'string') {
        try {
          const parsed = JSON.parse(rawError);
          contificoMensaje = parsed.mensaje || rawError;
        } catch {
          contificoMensaje = rawError;
        }
      }

      const err = new Error(contificoMensaje) as any;
      err.isContificoError = true;
      throw err;
    }

    // Update Order
    order.invoiceStatus = "PROCESSED";
    order.invoiceInfo = invoiceResponse;
    await order.save();

    // Trigger SRI (Non-blocking) — sendToSriWhenReady espera firma de Contifico antes de enviar al SRI
    const sriSentAt = new Date();
    svc.sendToSriWhenReady(invoiceResponse.id)
      .then(async () => {
        await models.orders.findByIdAndUpdate(id, { invoiceSentToSriAt: sriSentAt });
      })
      .catch(err => console.error("SRI Error:", err));

    // Auto-Register Collection if exists
    // SKIP if it's Credit (CR)
    if (order.paymentDetails && order.paymentDetails.monto && order.paymentDetails.forma_cobro !== 'CR') {
      try {
        const collectionPayload = {
          ...order.paymentDetails,
          monto: invoiceResponse.total,
        };
        await svc.registerCollection(invoiceResponse.id, collectionPayload);
      } catch (err) {
        console.error("Auto-collection error:", err);
      }
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Invoice generated successfully.",
      order
    });
    return;

  } catch (error: any) {
    console.error("Error generating invoice:", error);

    try {
      await models.orders.findByIdAndUpdate(req.params.id, { invoiceStatus: 'ERROR', invoiceError: error.message });
    } catch (e) { }

    const contificoMessage = error.isContificoError ? error.message : null;

    res.status(HttpStatusCode.InternalServerError).send({
      message: contificoMessage
        ? `Error de Contífico: ${contificoMessage}`
        : "Error al generar la factura.",
      contificoMessage: contificoMessage || null,
      error: error.message || String(error)
    });
    return;
  }
}

/**
 * Regenerate invoice: repara una factura rota (subtotal_12=0) vía PUT en Contífico.
 * La API de Contífico no soporta DELETE de documentos — usamos PUT para corregir
 * los valores y que Contífico re-firme y re-envíe al SRI automáticamente.
 * POST /api/orders/:id/invoice/regenerate
 */
export async function regenerateInvoice(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    const existingDocId = (order as any).invoiceInfo?.id;
    const forceNew = req.query.force === 'true';
    let svc = getContificoService((order as any).contificoSource);
    let invoiceResponse: any;

    // Si se pasa invoiceDataOverride en el body, actualizar los datos de factura antes de crear
    const { invoiceDataOverride } = req.body || {};
    if (invoiceDataOverride) {
      (order as any).invoiceData = invoiceDataOverride;
    }

    // Si el documento ya fue firmado pero nunca autorizado por SRI, está "contaminado"
    // por intentos fallidos — crear documento nuevo en lugar de reparar vía PUT.
    const docFirmadoSinAutorizacion =
      (order as any).invoiceInfo?.firmado && !(order as any).invoiceInfo?.autorizacion;

    if (existingDocId && !forceNew && !docFirmadoSinAutorizacion) {
      // Step 1: Intentar reparar via PUT (corrige subtotal_12 y re-firma)
      console.log(`[regenerate] Repairing Contifico doc ${existingDocId} via PUT...`);
      try {
        invoiceResponse = await svc.repairDocument(existingDocId, order);
        console.log(`✅ [regenerate] PUT repair succeeded for doc ${existingDocId}`);
      } catch (repairErr: any) {
        // Si PUT falla (ej: doc ya autorizado o no se puede modificar),
        // crear un documento nuevo en Contífico
        console.warn(`⚠️ [regenerate] PUT repair failed: ${repairErr.message}. Creating new document...`);
        invoiceResponse = null;
      }
    } else if (existingDocId && (forceNew || docFirmadoSinAutorizacion)) {
      console.log(`[regenerate] Creating new Contifico doc (forceNew=${forceNew}, firmadoSinAuth=${docFirmadoSinAutorizacion})...`);
    }

    if (!invoiceResponse) {
      // Step 2: Reset state y crear nueva factura (fallback)
      (order as any).invoiceStatus = "PENDING";
      (order as any).invoiceInfo = null;
      (order as any).invoiceError = null;
      (order as any).invoiceSentToSriAt = null;
      (order as any).invoiceNeeded = true;
      await order.save();

      invoiceResponse = await svc.createInvoice(order);
    }

    const isWrongCompanyError = (resp: any) => {
      const msg = typeof resp?.error === 'object'
        ? (resp.error?.mensaje || JSON.stringify(resp.error))
        : String(resp?.error || '');
      return msg.includes('no pertenece a la empresa');
    };

    if (invoiceResponse.error && isWrongCompanyError(invoiceResponse)) {
      const alternateSvc = svc.source === 'sucree' ? nicoleContificoService : sucreeContificoService;
      svc = alternateSvc;
      invoiceResponse = await svc.createInvoice(order);
      if (!invoiceResponse.error) {
        await models.orders.findByIdAndUpdate(id, { contificoSource: alternateSvc.source });
      }
    }

    if (invoiceResponse.error) {
      let contificoMensaje = '';
      const rawError = invoiceResponse.error;
      if (typeof rawError === 'object' && rawError !== null) {
        contificoMensaje = rawError.mensaje || JSON.stringify(rawError);
      } else {
        contificoMensaje = String(rawError);
      }
      const err = new Error(contificoMensaje) as any;
      err.isContificoError = true;
      throw err;
    }

    order.invoiceStatus = "PROCESSED";
    order.invoiceInfo = invoiceResponse;
    await order.save();

    const sriSentAt = new Date();
    svc.sendToSriWhenReady(invoiceResponse.id)
      .then(async () => {
        await models.orders.findByIdAndUpdate(id, { invoiceSentToSriAt: sriSentAt });
      })
      .catch(err => console.error("SRI Error (regenerate):", err));

    if ((order as any).paymentDetails?.monto && (order as any).paymentDetails?.forma_cobro !== 'CR') {
      try {
        const collectionPayload = {
          ...(order as any).paymentDetails,
          monto: invoiceResponse.total,
        };
        await svc.registerCollection(invoiceResponse.id, collectionPayload);
      } catch (err) {
        console.error("Auto-collection error (regenerate):", err);
      }
    }

    res.status(HttpStatusCode.Ok).send({ message: "Invoice regenerated successfully.", order });
    return;

  } catch (error: any) {
    console.error("Error regenerating invoice:", error);
    try {
      await models.orders.findByIdAndUpdate(req.params.id, { invoiceStatus: 'ERROR', invoiceError: error.message });
    } catch (e) { }
    const contificoMessage = error.isContificoError ? error.message : null;
    res.status(HttpStatusCode.InternalServerError).send({
      message: contificoMessage
        ? `Error de Contífico: ${contificoMessage}`
        : "Error al regenerar la factura.",
      contificoMessage: contificoMessage || null,
      error: error.message || String(error)
    });
    return;
  }
}

/**
 * Get Invoice PDF Link
 * GET /api/orders/:id/invoice-pdf
 */
export async function getInvoicePdf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order || !order.invoiceInfo?.id) {
      res.status(HttpStatusCode.NotFound).send({ message: "Invoice not found for this order." });
      return;
    }

    const doc = await withCorrectService(
      id,
      (order as any).contificoSource,
      svc => svc.getDocument(order.invoiceInfo.id)
    );

    res.status(HttpStatusCode.Ok).send({
      message: "Invoice retrieved",
      document: doc
    });
    return;

  } catch (error: any) {
    console.error("Error fetching invoice PDF:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Failed to fetch invoice PDF",
      error: error.message
    });
    return;
  }
}

/**
 * GET /api/orders/:id/invoice/auth-status
 * Returns the SRI authorization estado of the Contífico document.
 */
export async function getInvoiceAuthStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order || !order.invoiceInfo?.id) {
      res.status(HttpStatusCode.NotFound).send({ message: "No invoice found for this order." });
      return;
    }

    const estado = await withCorrectService(
      id,
      (order as any).contificoSource,
      svc => svc.getDocumentEstado(order.invoiceInfo.id)
    );
    res.status(HttpStatusCode.Ok).send(estado);
    return;
  } catch (error: any) {
    console.error("Error fetching invoice auth status:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: error.message });
    return;
  }
}

/**
 * POST /api/orders/:id/invoice/authorize
 * Re-triggers sending the Contífico document to SRI for authorization.
 */
export async function triggerInvoiceAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order || !order.invoiceInfo?.id) {
      res.status(HttpStatusCode.NotFound).send({ message: "No invoice found for this order." });
      return;
    }

    const result = await withCorrectService(
      id,
      (order as any).contificoSource,
      svc => svc.sendToSri(order.invoiceInfo.id)
    );

    // sendToSri retorna { error: ... } sin lanzar excepción — debemos chequearlo explícitamente
    if (result?.error) {
      const errorMsg = typeof result.error === 'object'
        ? (result.error?.mensaje || result.error?.detail || JSON.stringify(result.error))
        : String(result.error);
      console.error(`❌ SRI authorize error for order ${id}:`, result.error);
      res.status(HttpStatusCode.BadGateway).send({
        message: `Error al enviar al SRI: ${errorMsg}`,
        contificoError: result.error
      });
      return;
    }

    // Registrar el momento en que se envió al SRI para detectar si supera 1 hora sin aprobar
    order.invoiceSentToSriAt = new Date();
    await order.save();
    res.status(HttpStatusCode.Ok).send({ message: "Autorización enviada al SRI.", result });
    return;
  } catch (error: any) {
    console.error("Error triggering invoice auth:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: error.message });
    return;
  }
}

/**
 * POST /api/orders/invoice/batch-reauthorize
 * Finds all PROCESSED orders with no SRI authorization and attempts to re-authorize them.
 * Processes up to 20 orders at a time.
 */
export async function batchReauthorizeInvoices(req: AuthRequest, res: Response, next: NextFunction) {
  type OrderResult = {
    orderId: string;
    customerName: string;
    action: "skipped" | "sentToSri" | "regenerated" | "failed";
    detail?: string;
  };

  const summary = {
    found: 0,
    sentToSri: 0,
    regenerated: 0,
    skipped: 0,
    failed: 0,
    results: [] as OrderResult[]
  };

  // Helper: extract readable error string from Contifico/SRI error objects
  const extractErr = (e: any): string => {
    if (!e) return "unknown error";
    if (typeof e === "string") return e;
    return e.mensaje || e.detail || e.message || JSON.stringify(e);
  };

  // Helper: fire-and-forget SRI send with DB error persistence
  const fireSriSend = (svc: any, docId: string, orderId: string, sriSentAt: Date) => {
    svc.sendToSriWhenReady(docId)
      .then(async (sriResult: any) => {
        if (sriResult?.error) {
          const errMsg = extractErr(sriResult.error);
          await models.orders.findByIdAndUpdate(orderId, {
            invoiceStatus: "ERROR",
            invoiceError: `SRI: ${errMsg}`
          });
          console.error(`❌ SRI rejected [${orderId}]: ${errMsg}`);
        } else {
          await models.orders.findByIdAndUpdate(orderId, {
            invoiceSentToSriAt: sriSentAt,
            invoiceError: null
          });
        }
      })
      .catch((err: any) => console.error(`SRI Error (batch-reauth) [${orderId}]:`, err));
  };

  // Process a single order — returns an OrderResult
  const processOrder = async (order: any): Promise<OrderResult> => {
    const orderId = String(order._id);
    const customerName: string = order.customerName || orderId;

    try {
      // Case A: no invoiceInfo at all → create from scratch
      if (!order.invoiceInfo?.id) {
        order.invoiceStatus = "PENDING";
        order.invoiceInfo = null;
        order.invoiceError = null;
        order.invoiceSentToSriAt = null;
        order.invoiceNeeded = true;
        await order.save();

        const invoiceResponse = await withCorrectService(orderId, order.contificoSource, s => s.createInvoice(order));
        if (invoiceResponse?.error) {
          const errMsg = extractErr(invoiceResponse.error);
          order.invoiceStatus = "ERROR";
          order.invoiceError = errMsg;
          await order.save();
          return { orderId, customerName, action: "failed", detail: errMsg };
        }
        order.invoiceStatus = "PROCESSED";
        order.invoiceInfo = invoiceResponse;
        order.invoiceError = null;
        await order.save();
        fireSriSend(getContificoService(order.contificoSource), invoiceResponse.id, orderId, new Date());
        return { orderId, customerName, action: "regenerated", detail: `Nueva factura: ${invoiceResponse.id}` };
      }

      // Case B: has invoiceInfo — check estado in Contifico
      let estado: any;
      try {
        estado = await withCorrectService(orderId, order.contificoSource,
          svc => svc.getDocumentEstado(order.invoiceInfo.id)
        );
      } catch (estadoErr: any) {
        const msg: string = estadoErr?.message || String(estadoErr);
        // Document no longer exists in Contifico — recreate from scratch
        if (msg.toLowerCase().includes('no existe') || msg.toLowerCase().includes('not found')) {
          order.invoiceStatus = "PENDING";
          order.invoiceInfo = null;
          order.invoiceError = null;
          order.invoiceSentToSriAt = null;
          order.invoiceNeeded = true;
          await order.save();
          const invoiceResponse = await withCorrectService(orderId, order.contificoSource, s => s.createInvoice(order));
          if (invoiceResponse?.error) {
            const errMsg = extractErr(invoiceResponse.error);
            order.invoiceStatus = "ERROR";
            order.invoiceError = errMsg;
            await order.save();
            return { orderId, customerName, action: "failed", detail: errMsg };
          }
          order.invoiceStatus = "PROCESSED";
          order.invoiceInfo = invoiceResponse;
          order.invoiceError = null;
          await order.save();
          fireSriSend(getContificoService(order.contificoSource), invoiceResponse.id, orderId, new Date());
          return { orderId, customerName, action: "regenerated", detail: `Recreada desde cero: ${invoiceResponse.id}` };
        }
        throw estadoErr;
      }
      const estadoValue: string = estado?.estado || estado?.Estado || "";

      if (estadoValue === "Autorizado") {
        // El endpoint /estado/ no devuelve el número de autorización — hay que
        // consultar el documento completo para obtenerlo y guardarlo en la BD.
        try {
          const fullDoc = await withCorrectService(orderId, order.contificoSource,
            svc => svc.getDocument(order.invoiceInfo.id)
          );
          if (fullDoc?.autorizacion) {
            await models.orders.findByIdAndUpdate(orderId, {
              "invoiceInfo.autorizacion": fullDoc.autorizacion,
              invoiceError: null
            });
          }
        } catch { /* si falla la consulta, el doc ya está autorizado; continua */ }
        return { orderId, customerName, action: "skipped", detail: "Ya autorizado en Contifico" };
      }

      if (estadoValue === "Enviado SRI") {
        // If subtotal_12 is 0, the doc was sent to SRI with a bug — SRI will reject it
        // Repair it now before SRI responds (PUT resets the doc so it can be corrected)
        const storedSub12 = String((order.invoiceInfo as any)?.subtotal_12 ?? "");
        if (storedSub12 !== "0.0" && storedSub12 !== "0") {
          return { orderId, customerName, action: "skipped", detail: "Enviado al SRI, esperando respuesta" };
        }
        // subtotal_12 = 0 → fall through to repair/recreate block below
      }

      if (estadoValue === "Firmado") {
        // If subtotal_12 is 0 the doc was created with the old bug → repair it first
        const storedSubtotal12 = String((order.invoiceInfo as any)?.subtotal_12 ?? "");
        const needsRepair = storedSubtotal12 === "0.0" || storedSubtotal12 === "0";
        if (!needsRepair) {
          const result = await withCorrectService(orderId, order.contificoSource,
            s => s.sendToSri(order.invoiceInfo.id)
          );
          if ((result as any)?.error) {
            const errMsg = extractErr((result as any).error);
            order.invoiceStatus = "ERROR";
            order.invoiceError = errMsg;
            await order.save();
            return { orderId, customerName, action: "failed", detail: errMsg };
          }
          order.invoiceSentToSriAt = new Date();
          order.invoiceError = null;
          await order.save();
          return { orderId, customerName, action: "sentToSri", detail: `Doc: ${order.invoiceInfo.id}` };
        }
        // subtotal_12 = 0 → fall through to repair/recreate block below
      }

      // Case C: No Firmado or unknown estado → repair or recreate
      const svc = getContificoService(order.contificoSource);
      const existingDocId = order.invoiceInfo?.id;
      let invoiceResponse: any = null;

      if (existingDocId) {
        try { invoiceResponse = await svc.repairDocument(existingDocId, order); } catch { invoiceResponse = null; }
      }

      if (!invoiceResponse || invoiceResponse?.error) {
        // Repair failed — check if this is an inventory duplicate-entry lock
        const repairErrMsg = invoiceResponse ? extractErr(invoiceResponse.error) : "";
        const isInventoryLock = repairErrMsg.toLowerCase().includes("duplicate entry");

        if (isInventoryLock) {
          // Contifico inventory movements already exist for this doc — cannot repair or recreate.
          // Preserve the original invoiceInfo.id so we don't lose the Contifico reference.
          // The doc will need manual intervention (void + recreate) in Contifico.
          order.invoiceStatus = "ERROR";
          order.invoiceError = `Bloqueo de inventario Contifico: ${repairErrMsg}`;
          await order.save();
          return { orderId, customerName, action: "failed", detail: `Bloqueo inventario: ${repairErrMsg.slice(0, 120)}` };
        }

        // Fall back to full recreate (only when it's not an inventory lock)
        const savedInvoiceInfo = order.invoiceInfo; // preserve in case create also fails
        order.invoiceStatus = "PENDING";
        order.invoiceInfo = null;
        order.invoiceError = null;
        order.invoiceSentToSriAt = null;
        order.invoiceNeeded = true;
        await order.save();
        invoiceResponse = await withCorrectService(orderId, order.contificoSource, s => s.createInvoice(order));

        if (!invoiceResponse || invoiceResponse?.error) {
          // Restore original invoiceInfo so we don't lose the Contifico doc reference
          order.invoiceStatus = "ERROR";
          order.invoiceInfo = savedInvoiceInfo;
          order.invoiceError = invoiceResponse ? extractErr(invoiceResponse.error) : "createInvoice returned null";
          await order.save();
          return { orderId, customerName, action: "failed", detail: order.invoiceError };
        }
      }

      if (invoiceResponse?.error) {
        const errMsg = extractErr(invoiceResponse.error);
        order.invoiceStatus = "ERROR";
        order.invoiceError = errMsg;
        await order.save();
        return { orderId, customerName, action: "failed", detail: errMsg };
      }

      order.invoiceStatus = "PROCESSED";
      order.invoiceInfo = invoiceResponse;
      order.invoiceError = null;
      await order.save();
      fireSriSend(svc, invoiceResponse.id, orderId, new Date());
      return { orderId, customerName, action: "regenerated", detail: `Doc: ${invoiceResponse.id} (estado anterior: ${estadoValue || "sin estado"})` };

    } catch (stepError: any) {
      const errMsg = stepError?.message || String(stepError);
      console.error(`❌ [batch-reauthorize] Order ${orderId}:`, errMsg);
      try {
        order.invoiceStatus = "ERROR";
        order.invoiceError = errMsg;
        await order.save();
      } catch { /* ignore */ }
      return { orderId, customerName, action: "failed", detail: errMsg };
    }
  };

  try {
    // Fetch ALL non-authorized orders (PROCESSED + ERROR, no limit)
    // Include autorizacion="" because Contifico initializes the field as empty string
    const orders = await models.orders.find({
      invoiceNeeded: true,
      invoiceStatus: { $in: ["PROCESSED", "ERROR"] },
      "invoiceInfo.autorizacion": { $in: [null, undefined, ""] },
      voidedAt: null
    });

    summary.found = orders.length;
    console.log(`🔄 batch-reauthorize: found ${orders.length} orders to process`);

    // Process in parallel chunks of 5 to avoid overwhelming Contifico
    const CHUNK_SIZE = 5;
    for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
      const chunk = orders.slice(i, i + CHUNK_SIZE);
      const chunkResults = await Promise.all(chunk.map(o => processOrder(o)));
      for (const r of chunkResults) {
        summary.results.push(r);
        if (r.action === "sentToSri")    summary.sentToSri++;
        else if (r.action === "regenerated") summary.regenerated++;
        else if (r.action === "skipped")     summary.skipped++;
        else if (r.action === "failed")      summary.failed++;
      }
      console.log(`  chunk ${Math.floor(i / CHUNK_SIZE) + 1}: processed ${chunk.length} orders`);
    }

    console.log(`✅ batch-reauthorize complete: sentToSri=${summary.sentToSri} regenerated=${summary.regenerated} skipped=${summary.skipped} failed=${summary.failed}`);
    res.status(HttpStatusCode.Ok).send(summary);
    return;
  } catch (error: any) {
    console.error("❌ Error in batchReauthorizeInvoices:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: error.message });
    return;
  }
}

/**
 * POST /api/orders/invoice/sync-authorizations
 * Pulls authorization status from Contifico for all PROCESSED orders with autorizacion=null
 * and updates the DB. Also triggers sendToSri for documents that are "Firmado" but not sent.
 * Safe to run multiple times (idempotent).
 */
export async function syncInvoiceAuthorizations(req: AuthRequest, res: Response, next: NextFunction) {
  const summary = { found: 0, authorized: 0, sentToSri: 0, stillPending: 0, failed: 0 };
  const details: Array<{ orderId: string; customerName: string; action: string; autorizacion?: string }> = [];

  try {
    // All PROCESSED orders with a Contifico doc ID but no local autorizacion
    // Include autorizacion="" because Contifico initializes the field as empty string
    const orders = await models.orders.find({
      invoiceStatus: "PROCESSED",
      "invoiceInfo.id": { $exists: true, $ne: null },
      "invoiceInfo.autorizacion": { $in: [null, undefined, ""] },
      voidedAt: null
    });

    summary.found = orders.length;
    console.log(`🔍 sync-authorizations: ${orders.length} PROCESSED orders without autorizacion`);

    const CHUNK = 10;
    for (let i = 0; i < orders.length; i += CHUNK) {
      const chunk = orders.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async (order) => {
        const orderId = String((order as any)._id);
        const customerName: string = (order as any).customerName || orderId;
        try {
          // Use getDocument (full doc) — has real autorizacion field and estado code ("C","P","A")
          // /estado/ endpoint only shows signing state, not SRI state
          const doc = await withCorrectService(orderId, (order as any).contificoSource,
            svc => svc.getDocument((order as any).invoiceInfo.id)
          );

          const autorizacion: string | null = doc?.autorizacion || null;
          const estadoCode: string = doc?.estado || ""; // "C"=Creado, "P"=Pendiente SRI, "A"=Autorizado
          const firmado: boolean = !!doc?.firmado;

          if (autorizacion) {
            // SRI authorized — save authorization number to DB
            await models.orders.findByIdAndUpdate(orderId, {
              "invoiceInfo.autorizacion": autorizacion,
              invoiceError: null
            });
            summary.authorized++;
            details.push({ orderId, customerName, action: "authorized", autorizacion });
          } else if (estadoCode === "P" || estadoCode === "E") {
            // "P" = En cola SRI / "E" = Enviado SRI — SRI is processing, just wait
            summary.stillPending++;
            details.push({ orderId, customerName, action: `pending:EnviadoSRI` });
          } else if (firmado) {
            // Firmado (estado "C") but NOT in SRI queue yet — sendToSri didn't queue it
            // Always retry sendToSri when estado is "C" (not "P"/"E")
            const result = await withCorrectService(orderId, (order as any).contificoSource,
              svc => svc.sendToSri((order as any).invoiceInfo.id)
            );
            if ((result as any)?.error) {
              const errMsg = typeof (result as any).error === 'object'
                ? ((result as any).error?.mensaje || JSON.stringify((result as any).error))
                : String((result as any).error);
              await models.orders.findByIdAndUpdate(orderId, { invoiceStatus: "ERROR", invoiceError: errMsg });
              summary.failed++;
              details.push({ orderId, customerName, action: "failed" });
            } else {
              // Check if sendToSri actually queued it (estado should be "P" now)
              const newEstado: string = (result as any)?.estado || "";
              await models.orders.findByIdAndUpdate(orderId, { invoiceSentToSriAt: new Date(), invoiceError: null });
              if (newEstado === "P" || newEstado === "E") {
                summary.sentToSri++;
                details.push({ orderId, customerName, action: "sentToSri" });
              } else {
                // Queued but SRI slow — mark pending
                summary.stillPending++;
                details.push({ orderId, customerName, action: "pending:queued" });
              }
            }
          } else {
            // Not signed yet — Contifico still processing
            summary.stillPending++;
            details.push({ orderId, customerName, action: `pending:noFirmado` });
          }
        } catch (err: any) {
          console.error(`❌ sync-auth [${orderId}]:`, err?.message);
          summary.failed++;
          details.push({ orderId, customerName, action: "error" });
        }
      }));
    }

    console.log(`✅ sync-authorizations done: authorized=${summary.authorized} sentToSri=${summary.sentToSri} pending=${summary.stillPending} failed=${summary.failed}`);
    res.status(HttpStatusCode.Ok).send({ ...summary, details });
    return;
  } catch (error: any) {
    console.error("❌ Error in syncInvoiceAuthorizations:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: error.message });
    return;
  }
}

/**
 * POST /api/orders/invoice/generate-missing
 * Generates invoices for all orders with invoiceNeeded=true that have no invoice yet
 * (invoiceStatus = null/undefined/PENDING and no invoiceInfo).
 * Excludes voided orders.
 */
export async function generateMissingInvoices(req: AuthRequest, res: Response, next: NextFunction) {
  const summary = { found: 0, generated: 0, failed: 0 };
  const details: Array<{ orderId: string; customerName: string; action: string; detail?: string }> = [];

  try {
    const orders = await models.orders.find({
      invoiceNeeded: true,
      invoiceStatus: { $in: [null, undefined, "PENDING"] },
      "invoiceInfo": { $in: [null, undefined] },
      voidedAt: null
    });

    summary.found = orders.length;
    console.log(`🔍 generate-missing: ${orders.length} orders need invoice`);

    const CHUNK = 3; // slower — creates new docs in Contifico
    for (let i = 0; i < orders.length; i += CHUNK) {
      const chunk = orders.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async (order) => {
        const orderId = String((order as any)._id);
        const customerName: string = (order as any).customerName || orderId;
        try {
          const invoiceResponse = await withCorrectService(orderId, (order as any).contificoSource,
            svc => svc.createInvoice(order)
          );
          if (invoiceResponse?.error) {
            const errMsg = typeof invoiceResponse.error === 'object'
              ? (invoiceResponse.error?.mensaje || JSON.stringify(invoiceResponse.error))
              : String(invoiceResponse.error);
            (order as any).invoiceStatus = "ERROR";
            (order as any).invoiceError = errMsg;
            await order.save();
            summary.failed++;
            details.push({ orderId, customerName, action: "failed", detail: errMsg });
            return;
          }
          (order as any).invoiceStatus = "PROCESSED";
          (order as any).invoiceInfo = invoiceResponse;
          (order as any).invoiceError = null;
          await order.save();

          const svc = getContificoService((order as any).contificoSource);
          const sriSentAt = new Date();
          svc.sendToSriWhenReady(invoiceResponse.id)
            .then(async (sriResult: any) => {
              if (sriResult?.error) {
                const errMsg = typeof sriResult.error === 'object'
                  ? (sriResult.error?.mensaje || sriResult.error?.detail || JSON.stringify(sriResult.error))
                  : String(sriResult.error);
                await models.orders.findByIdAndUpdate(orderId, { invoiceStatus: "ERROR", invoiceError: `SRI: ${errMsg}` });
              } else {
                await models.orders.findByIdAndUpdate(orderId, { invoiceSentToSriAt: sriSentAt, invoiceError: null });
              }
            })
            .catch((err: any) => console.error(`SRI Error (generate-missing) [${orderId}]:`, err));

          summary.generated++;
          details.push({ orderId, customerName, action: "generated", detail: invoiceResponse.id });
        } catch (err: any) {
          console.error(`❌ generate-missing [${orderId}]:`, err?.message);
          summary.failed++;
          details.push({ orderId, customerName, action: "error", detail: err?.message });
        }
      }));
    }

    console.log(`✅ generate-missing done: generated=${summary.generated} failed=${summary.failed}`);
    res.status(HttpStatusCode.Ok).send({ ...summary, details });
    return;
  } catch (error: any) {
    console.error("❌ Error in generateMissingInvoices:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: error.message });
    return;
  }
}

/**
 * Settle an order in a physical island (Branch)
 * Marks it as settled locally and registers an 'ISLA' payment.
 */
export async function settleOrderInIsland(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { islandName } = req.body;

    if (!islandName) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Island name is required." });
      return;
    }

    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    // 1. Update settlement fields
    order.settledInIsland = true;
    order.settledIslandName = islandName;

    // 2. Add 'ISLA' payment to mark as "Paid" in the system
    // We add it to the payments array and update paymentMethod
    const amountToSettle = order.totalValue;

    order.payments.push({
      forma_cobro: 'ISLA',
      monto: amountToSettle,
      fecha: new Date(),
      reference: `Settled in ${islandName}`,
      status: 'PAID'
    });

    // Update paymentMethod for summary
    order.paymentMethod = `Isla: ${islandName}`;

    // Update paymentDetails for list view legacy check (if still used)
    if (!order.paymentDetails?.monto) {
      order.paymentDetails = {
        forma_cobro: 'ISLA',
        monto: amountToSettle,
        fecha: new Date().toISOString().split('T')[0],
        numero_comprobante: `ISLA-${islandName}`
      };
    }

    await order.save();

    res.status(HttpStatusCode.Ok).send({
      message: "Order settled in island successfully.",
      order
    });
    return;
  } catch (error) {
    console.error("Error settling order in island:", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal Server Error" });
    return;
  }
}

/**
 * Get delivery report with totals and grouped data
 * GET /api/orders/reports/delivery
 */
export async function getDeliveryReport(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { startDate, endDate, deliveryPersonId, page = "1", limit = "10" } = req.query;

    if (!startDate || !endDate) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "startDate and endDate are required parameters (YYYY-MM-DD)."
      });
      return;
    }

    const pageNumber = parseInt(page as string, 10) || 1;
    const limitNumber = parseInt(limit as string, 10) || 10;
    const skip = (pageNumber - 1) * limitNumber;

    const query: any = {
      deliveryDate: {
        $gte: new Date(`${startDate}T00:00:00.000Z`),
        $lte: new Date(`${endDate}T23:59:59.999Z`)
      }
    };

    if (deliveryPersonId) {
      query["deliveryPerson.personId"] = deliveryPersonId;
    }

    const allOrders = await models.orders.find(query)
      .select("orderDate deliveryDate customerName deliveryValue deliveryPerson totalValue status products deliveryType")
      .sort({ deliveryDate: 1 });

    // Filter and map orders to include those that either have a deliveryValue OR a "Delivery" product
    const orders = allOrders.map(o => {
      let finalDeliveryValue = o.deliveryValue || 0;

      // Fallback: If deliveryValue is 0, check products for "Delivery"
      if (finalDeliveryValue === 0 && o.products) {
        const deliveryProduct = o.products.find((p: any) =>
          p.name.toLowerCase().includes("delivery") || p.name.toLowerCase().includes("envío")
        );
        if (deliveryProduct) {
          finalDeliveryValue = deliveryProduct.price * deliveryProduct.quantity;
        }
      }

      return {
        ...o.toObject(),
        deliveryValue: finalDeliveryValue
      };
    }).filter(o => o.deliveryValue > 0 || o.deliveryType === 'delivery');

    const total = orders.reduce((sum, o) => sum + (o.deliveryValue || 0), 0);

    // Grouping by delivery person for extra clarity
    const summaryByPerson = orders.reduce((acc: any, o: any) => {
      const personName = o.deliveryPerson?.name || "Sin asignar";
      if (!acc[personName]) {
        acc[personName] = { name: personName, total: 0, count: 0 };
      }
      acc[personName].total += (o.deliveryValue || 0);
      acc[personName].count += 1;
      return acc;
    }, {});

    const paginatedOrders = orders.slice(skip, skip + limitNumber);
    const totalPages = Math.ceil(orders.length / limitNumber) || 1;

    res.status(HttpStatusCode.Ok).send({
      message: "Delivery report retrieved successfully.",
      data: {
        total: Number(total.toFixed(2)),
        count: orders.length, // total items in date range
        totalPages,
        currentPage: pageNumber,
        summary: Object.values(summaryByPerson),
        orders: paginatedOrders // only return this page's items
      }
    });
    return;
  } catch (error) {
    console.error("❌ Error in getDeliveryReport:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error generating delivery report.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Bulk assign multiple orders to a delivery person
 * POST /api/orders/bulk-assign
 */
export async function bulkAssignOrders(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { orderIds, deliveryPerson } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "No order IDs provided." });
      return;
    }

    // Prepare update object
    const update = {
      deliveryPerson: deliveryPerson || null, // null removes assignment
    };

    const result = await models.orders.updateMany(
      { _id: { $in: orderIds } },
      { $set: update }
    );

    res.status(HttpStatusCode.Ok).send({
      message: `${result.modifiedCount} orders updated successfully.`,
      modifiedCount: result.modifiedCount
    });
    return;
  } catch (error) {
    console.error("❌ Error in bulkAssignOrders:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error bulk assigning orders.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Reassign all orders from one delivery person to another (or unassign)
 * POST /api/orders/reassign-delivery
 */
export async function reassignDelivery(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { oldPersonId, newPerson } = req.body;

    if (!oldPersonId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Old Person ID is required." });
      return;
    }

    const update = {
      deliveryPerson: newPerson || null
    };

    const result = await models.orders.updateMany(
      { "deliveryPerson.personId": oldPersonId },
      { $set: update }
    );

    res.status(HttpStatusCode.Ok).send({
      message: `${result.modifiedCount} orders reassigned successfully.`,
      modifiedCount: result.modifiedCount
    });
    return;
  } catch (error) {
    console.error("❌ Error in reassignDelivery:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Error reassigning delivery.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}

/**
 * Return an order (Devolución)
 * PUT /api/orders/:id/return
 */
export async function returnOrder(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { notes, reportedBy } = req.body;

    if (!notes) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Reason for return (notes) is required." });
      return;
    }

    // Direct instantiation or use dependency injection if available
    const productionService = new (require("../services/production.service").ProductionService)();

    // Check if order exists first? Service handles it.
    // Call service
    await productionService.returnOrder(id, {
      notes,
      reportedBy: reportedBy || "Ventas/Web"
    });

    res.status(HttpStatusCode.Ok).send({
      message: "Order returned successfully."
    });

  } catch (error: any) {
    console.error("Error returning order:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Failed to return order.",
      error: error.message
    });
  }
}

/**
 * Delete an order permanently
 * DELETE /api/orders/:id
 */
export async function deleteOrder(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const order = await models.orders.findById(id);

    if (!order) {
      res.status(HttpStatusCode.NotFound).send({ message: "Order not found." });
      return;
    }

    // SAFETY CHECK: Prevent deletion if already invoiced in Contífico
    if (order.invoiceStatus === "PROCESSED") {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Cannot delete order. It has a processed invoice in Contífico. Void the invoice first if required."
      });
      return;
    }

    await models.orders.findByIdAndDelete(id);

    res.status(HttpStatusCode.Ok).send({
      message: "Order deleted successfully."
    });
    return;
  } catch (error) {
    console.error("❌ Error in deleteOrder:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "Internal server error while deleting order.",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
}
