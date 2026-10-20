import { normalizeString } from "../utils/string.utils";

/**
 * Mapeo sucursal del POS → puntos de emisión de Contífico (formato EEE-PPP,
 * los dos primeros bloques del número de factura).
 *
 * Puntos de emisión reales de la cuenta Nicole (GET /pos/):
 *   001-002  Caja Dulcería   → Isla Mall del Sol (comparte bodega con BOD001
 *                              "Isla Nicole Pastry Arts Mall del sol")
 *   001-003  Caja Heladería  → Isla Dela Crem
 *   001-004  Caja Casa Mía
 *   001-005  C.C. San Marino → Isla San Marino
 *
 * Se puede sobreescribir sin tocar código con la variable de entorno
 * CONTIFICO_POS_SUCURSALES, ej.:
 *   CONTIFICO_POS_SUCURSALES="San Marino=001-005;Mall del Sol=001-002,001-003"
 *
 * Si una sucursal no está ni en el env ni aquí, se intenta por nombre: un
 * punto de emisión cuya `direccion` contenga el nombre de la sucursal.
 */
const BRANCH_POS_DEFAULTS: Record<string, string[]> = {
  "san marino": ["001-005"],
  "mall del sol": ["001-002"],
};

function parseEnvMap(): Record<string, string[]> {
  const raw = process.env.CONTIFICO_POS_SUCURSALES || "";
  const map: Record<string, string[]> = {};
  for (const pair of raw.split(";")) {
    const [branch, codes] = pair.split("=");
    if (!branch || !codes) continue;
    map[normalizeString(branch)] = codes
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }
  return map;
}

/**
 * Códigos EEE-PPP configurados para una sucursal, o null si no hay mapeo
 * explícito (el caller puede caer al match por nombre).
 */
export function getBranchPuntoCodes(branch: string): string[] | null {
  const key = normalizeString(branch);
  const fromEnv = parseEnvMap()[key];
  if (fromEnv && fromEnv.length) return fromEnv;
  return BRANCH_POS_DEFAULTS[key] || null;
}
