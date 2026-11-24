// Inventario semanal (toma de los lunes): productos por bloques y utensilios con foto.
// Pedido de Operaciones (16/11/2026). El catálogo lo arma el Jefe de Operaciones desde Ajustes.

export type InventoryCompany = "nicole" | "sucree";
export const INVENTORY_COMPANIES: InventoryCompany[] = ["nicole", "sucree"];

/** Bloques de productos. Los utensilios son un bloque aparte ("ut"). */
export type InventoryProductBlock = "pt" | "pp" | "mp";
export type InventoryBlock = InventoryProductBlock | "ut";
export const INVENTORY_PRODUCT_BLOCKS: InventoryProductBlock[] = ["pt", "pp", "mp"];
export const INVENTORY_BLOCKS: InventoryBlock[] = ["pt", "pp", "mp", "ut"];

export const INVENTORY_BLOCK_TITLES: Record<InventoryProductBlock, string> = {
  pt: "Producto terminado",
  pp: "Producto en proceso",
  mp: "Materia prima",
};

/** Unidad con la que arranca cada producto nuevo del bloque. */
export const INVENTORY_DEFAULT_UNIT: Record<InventoryProductBlock, string> = {
  pt: "unid.",
  pp: "kg",
  mp: "kg",
};

export const INVENTORY_DEFAULT_UNITS = ["unid.", "kg", "g", "lt", "ml", "bandeja", "funda"];

/** Toma de inventario: usuario de producción y Jefe de Operaciones (y administradores). */
export const INVENTORY_COUNT_ROLES = ["PRODUCTION", "OPERATIONS_MANAGER", "SUPERADMIN", "ADMIN"];
/** Ajustes del catálogo: solo el Jefe de Operaciones (y administradores). */
export const INVENTORY_SETTINGS_ROLES = ["OPERATIONS_MANAGER", "SUPERADMIN", "ADMIN"];

/**
 * La toma de inventario se hace solo los lunes (pedido de Operaciones, 23/11/2026). Cada toma
 * cierra la semana anterior del Movimiento de inventario.
 */
export const INVENTORY_COUNT_WEEKDAY = 1; // lunes (getUTCDay sobre la fecha de Ecuador)

/**
 * El Movimiento de inventario empieza con la toma del lunes 23/11/2026 (ese día se empezó a
 * registrar la producción en la tablet). Lo anterior no se muestra.
 */
export const INVENTORY_MOVEMENT_START = "2026-11-23";

export const INVENTORY_RULES = {
  /** Columnas de conteos anteriores que se muestran en utensilios. */
  historyWeeks: 3,
  /** Tamaño máximo de la foto del utensilio (data URL JPEG comprimida). */
  maxPhotoChars: 160_000,
  maxNameChars: 80,
  maxCategories: 200,
  maxProductsPerBlock: 2000,
  maxUnits: 30,
  maxQuantity: 1_000_000,
};
