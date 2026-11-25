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

/**
 * Tortas enteras en el Movimiento de inventario (Ricardo, 25/11/2026).
 * El inventario y la tablet llevan porciones: una torta entera despachada sale de las porciones
 * de su sabor. Cada torta entera = 10 porciones; la Tarta queso KETO = 8.
 * Código Contífico de la torta entera (CAKE-…) → porción del catálogo (CAKP-…). Los números no
 * coinciden entre sí, por eso la tabla es explícita. Las que no están aquí (personalizada, caja
 * degustación, tartas vascas de sabores, Tronco, Pavlova…) siguen en la nota "no se restan".
 */
export const WHOLE_CAKE_PORTIONS: Record<InventoryCompany, Record<string, { portion: string; portions: number }>> = {
  nicole: {
    "CAKE-001": { portion: "CAKP-001", portions: 10 }, // Affogato
    "CAKE-002": { portion: "CAKP-002", portions: 10 }, // Arandanos & Nido
    "CAKE-003": { portion: "CAKP-003", portions: 10 }, // Hazelnut
    "CAKE-005": { portion: "CAKP-004", portions: 10 }, // Chocolate & Frutos rojos
    "CAKE-006": { portion: "CAKP-018", portions: 10 }, // Torta Navideña
    "CAKE-007": { portion: "CAKP-006", portions: 10 }, // Cuatro Leches
    "CAKE-009": { portion: "CAKP-009", portions: 10 }, // Peach Melba
    "CAKE-011": { portion: "CAKP-010", portions: 10 }, // Tarta de Queso (vasca)
    "CAKE-013": { portion: "CAKP-012", portions: 10 }, // Tiramisu
    "CAKE-014": { portion: "CAKP-011", portions: 8 }, // Tarta queso KETO
    "CAKE-016": { portion: "CAKP-013", portions: 10 }, // Mango & Maracuya
    "CAKE-018": { portion: "CAKP-019", portions: 10 }, // Fraisier
    "CAKE-019": { portion: "CAKP-016", portions: 10 }, // Torta Salted Caramel
  },
  sucree: {},
};
