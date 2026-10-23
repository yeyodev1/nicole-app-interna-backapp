/**
 * Limpieza para arrancar el módulo de reposición con datos limpios.
 *
 * Borra SOLO datos internos del ciclo de reposición:
 *   - Pedidos de reposición (orders con salesChannel Restock / Restock-Bodega)
 *   - Requerimientos internos (internalrequisitions, todos)
 *
 * NO toca ninguna venta: los pedidos de clientes (cualquier otro salesChannel)
 * quedan intactos, igual que cierres diarios, bajas y todo lo demás.
 *
 * Uso:
 *   pnpm clean:replenishment              → dry-run (solo cuenta, no borra)
 *   pnpm clean:replenishment -- --confirm → borra de verdad
 */
import "dotenv/config";
import mongoose from "mongoose";

const RESTOCK_CHANNELS = ["Restock", "Restock-Bodega"];

async function main() {
  const confirm = process.argv.includes("--confirm");

  if (!process.env.DB_URI) throw new Error("Falta DB_URI en el .env");
  await mongoose.connect(process.env.DB_URI);
  const db = mongoose.connection;

  const orders = db.collection("orders");
  const requisitions = db.collection("internalrequisitions");

  const restockFilter = { salesChannel: { $in: RESTOCK_CHANNELS } };

  const [restockCount, reqCount, salesCount] = await Promise.all([
    orders.countDocuments(restockFilter),
    requisitions.countDocuments({}),
    orders.countDocuments({ salesChannel: { $nin: RESTOCK_CHANNELS } }),
  ]);

  console.log(`Reposiciones (orders Restock/Restock-Bodega): ${restockCount}`);
  console.log(`Requerimientos internos (todos):              ${reqCount}`);
  console.log(`Ventas/pedidos de clientes (NO se tocan):     ${salesCount}`);

  if (!confirm) {
    console.log("\nDry-run: no se borró nada. Ejecuta con -- --confirm para borrar.");
  } else {
    const r1 = await orders.deleteMany(restockFilter);
    const r2 = await requisitions.deleteMany({});
    console.log(`\n🧹 Borrado: ${r1.deletedCount} reposiciones y ${r2.deletedCount} requerimientos.`);
    console.log("Las ventas quedaron intactas.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
