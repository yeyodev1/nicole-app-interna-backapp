/**
 * Productos cuyo precio escrito por el vendedor YA incluye IVA.
 *
 * Para el resto del catálogo el precio que se teclea es la base imponible y el 15%
 * se suma encima. Para estos, no: lo que se teclea es lo que el cliente paga, así
 * que la base se calcula hacia atrás (precio / 1.15) y el IVA sale de ahí. El total
 * de la factura termina siendo exactamente el valor tecleado.
 *
 * Delivery siempre se comportó así (se detectaba por el nombre). Desde el 17/09/2026
 * se suma "Torta Personalizada" de Sucree (TORT-001), un producto `pvp_manual` donde
 * el vendedor cotiza la torta a pedido y el valor acordado con la clienta es el final.
 *
 * Se listan por ID de Contífico y no por nombre: el nombre lo puede editar cualquiera
 * desde Contífico y el cálculo del IVA dejaría de aplicar en silencio.
 */

/** IDs de Contífico con precio IVA incluido. Env: lista separada por comas. */
export const CONTIFICO_PRECIO_FINAL_IDS = new Set(
  (process.env.CONTIFICO_PRECIO_FINAL_IDS || "O8bYJlo4iLmlyd7j")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

/**
 * `true` si el precio del ítem ya trae el IVA dentro.
 * Cubre los IDs configurados y, por compatibilidad, cualquier ítem llamado "delivery".
 */
export function isPrecioIvaIncluido(item: { contifico_id?: string; name?: string }): boolean {
  if (item.contifico_id && CONTIFICO_PRECIO_FINAL_IDS.has(item.contifico_id)) return true;
  return String(item.name ?? "").toLowerCase().includes("delivery");
}

/**
 * Producto "Delivery" de la cuenta Nicole en Contífico (código 950, `pvp_manual`),
 * consultado en /producto/ el 24/09/2026. Los pedidos de la tienda online lo usan
 * para el ítem de envío: sin él la factura caía al producto de prueba.
 * Env opcional: `CONTIFICO_DELIVERY_ID`.
 */
export const CONTIFICO_DELIVERY_ID = (process.env.CONTIFICO_DELIVERY_ID || "0pZeVwVRNf8ZAaGW").trim();

/** `true` si la línea es el envío (producto Delivery de Contífico o un ítem llamado "delivery"). */
export function isDeliveryLine(item: { contifico_id?: string; name?: string }): boolean {
  if (item.contifico_id && item.contifico_id === CONTIFICO_DELIVERY_ID) return true;
  const name = String(item.name ?? "").toLowerCase();
  return name.includes("delivery") || name.includes("envío") || name.includes("envio");
}

/**
 * Descuento (%) de una línea. Decisión de Nicole (30/10/2026): los descuentos se
 * calculan solo sobre los productos; el delivery se cobra completo siempre. La
 * cortesía (de la línea o del pedido entero) sigue regalando todo, envío incluido.
 * Debe coincidir con `lineDiscountPercent` de `src/constants/pricing.ts` del frontend.
 */
export function lineDiscountPercent(
  item: { contifico_id?: string; name?: string; isCourtesy?: boolean },
  order: { globalDiscountPercentage?: number; isGlobalCourtesy?: boolean },
): number {
  if (item.isCourtesy || order.isGlobalCourtesy) return 100;
  const global = Number(order.globalDiscountPercentage) || 0;
  if (global > 0 && !isDeliveryLine(item)) return Math.min(global, 100);
  return 0;
}
