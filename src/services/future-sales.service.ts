import { OrderModel } from "../models/order.model";
import { getECDateRange, getEcuadorNow } from "../utils/date.utils";
import { NOT_DISCARDED } from "../utils/reserva";
import { addDaysStr, buildFutureSales, RESTOCK_CHANNELS, type FutureSalesResult } from "../utils/future-sales.util";
import { ContificoService } from "./contifico.service";
import { buildContificoCategoryMaps, resolveProduct } from "../utils/contifico-categorias.util";
import { normalizeString } from "../utils/string.utils";


/**
 * Ventas a futuro (Orden 7). Solo lectura: no modifica ningún pedido.
 * Pedidos de clientes (delivery y pick up) con entrega en una ventana de 10 días
 * desde mañana (window = 0) o los bloques siguientes (window = 1, 2…), pendientes de enviar.
 */
export class FutureSalesService {
  private nicole = new ContificoService("nicole");
  private sucree = new ContificoService("sucree");

  async getFutureSales(window = 0, source?: "nicole" | "sucree"): Promise<FutureSalesResult> {
    const ec = getEcuadorNow();
    const today = `${ec.getUTCFullYear()}-${String(ec.getUTCMonth() + 1).padStart(2, "0")}-${String(ec.getUTCDate()).padStart(2, "0")}`;
    const w = Math.max(0, Math.min(36, Math.floor(window) || 0));
    const from = addDaysStr(today, 1 + 10 * w);
    const to = addDaysStr(from, 9);


    const query: any = {
      deliveryDate: { $gte: getECDateRange(from, false).startDate, $lte: getECDateRange(to, false).endDate },
      salesChannel: { $nin: RESTOCK_CHANNELS },
      productionStage: { $nin: ["VOID", "AWAITING_CLIENT"] },
      dispatchStatus: { $nin: ["SENT", "RETURNED"] },
      ...NOT_DISCARDED,
    };
    if (source) query.contificoSource = source;


    const orders = await OrderModel.find(query)
      .select("deliveryDate deliveryType salesChannel customerName products dispatches payments totalValue contificoSource")
      .lean();


    // Orden 8: un renglón por código de Contífico (contifico_id del producto o el nombre resuelto)
    const [mapsNicole, mapsSucree] = await Promise.all([buildContificoCategoryMaps(this.nicole), buildContificoCategoryMaps(this.sucree)]);
    return buildFutureSales(orders as any[], from, (p, order) => {
      const r = resolveProduct(order.contificoSource === "sucree" ? mapsSucree : mapsNicole, p.name, p.contifico_id);
      return { key: r.codigo ? `${order.contificoSource === "sucree" ? "s" : "n"}#${r.codigo}` : normalizeString(String(p.name || "")).replace(/\s+/g, " "), name: r.nombre };
    });
  }
}
