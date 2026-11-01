import * as dotenv from "dotenv";
dotenv.config();
import createApp from "./app";
import dbConnect from "./config/mongo";
import { models } from "./models";
import { UserService } from "./services/user.service";
import { Branch } from "./models/branch.model";
import { SellerModel } from "./models/seller.model";

const DEFAULT_BRANCHES = [
  { name: "San Marino",          sortOrder: 1 },
  { name: "Mall del Sol",        sortOrder: 2 },
  { name: "Entre Ríos",          sortOrder: 3 },
  { name: "Centro de Producción", sortOrder: 4 },
];

async function seedBranches() {
  for (const branch of DEFAULT_BRANCHES) {
    await Branch.updateOne(
      { name: branch.name },
      { $setOnInsert: { name: branch.name, isActive: true, sortOrder: branch.sortOrder } },
      { upsert: true }
    );
  }
  console.log("Default branches ensured.");
}

/**
 * Vendedores que pueden salir en la factura de Contífico (base de comisiones).
 * Los IDs y cédulas están verificados contra la API de Contífico — las cuatro
 * personas ya existen ahí con `es_vendedor: true`.
 */
const DEFAULT_SELLERS = [
  { source: "nicole" as const, name: "NOHELIA ARMAS BUSTOS",          identification: "0953691706", contificoPersonId: "BXdL8RlNmC231dJZ", sortOrder: 1 },
  { source: "nicole" as const, name: "FIALHO VARGAS FLAVIO FERNANDO", identification: "0926710666", contificoPersonId: "y7aAPx7yoF5RWegZ", sortOrder: 2 },
  { source: "nicole" as const, name: "DOMENICA SOLANGE AVILES ROBIN", identification: "0955801303", contificoPersonId: "jZdyrArWAc34MeJ4", sortOrder: 3 },
  { source: "nicole" as const, name: "REBECCA MARCELA PINTO PIVAQUE", identification: "0950639427", contificoPersonId: "XKdwjgAjoFnN1bgW", sortOrder: 4 },
  // Sucree es otra empresa en Contífico y `createOrder` valida la cédula filtrando
  // por `contificoSource`. Sin estos dos, ningún pedido de Sucree con vendedor
  // asignado se podía guardar: devolvía 400 (roto del 31/08 al 17/09/2026).
  { source: "sucree" as const, name: "Joel Mendoza",                  identification: "1351257298", contificoPersonId: "KVeZVL6Zs5AgWe8P", sortOrder: 1 },
  { source: "sucree" as const, name: "Maria Fernanda Sampedro",       identification: "0927747618", contificoPersonId: "Ejb2v5lohpW3DbVN", sortOrder: 2 },
];

async function seedSellers() {
  for (const seller of DEFAULT_SELLERS) {
    await SellerModel.updateOne(
      { contificoSource: seller.source, identification: seller.identification },
      {
        // El nombre y el ID de Contífico se refrescan siempre para que un cambio
        // en el ERP no deje al catálogo apuntando a una persona equivocada.
        $set: {
          name: seller.name,
          contificoPersonId: seller.contificoPersonId,
          sortOrder: seller.sortOrder,
        },
        $setOnInsert: { contificoSource: seller.source, identification: seller.identification, isActive: true },
      },
      { upsert: true }
    );
  }
  console.log("Default sellers ensured.");
}

/**
 * El servidor escucha de inmediato: en Vercel (modo "legacy server") la función falla con
 * FUNCTION_INVOCATION_FAILED si tarda en escuchar en un arranque en frío. La conexión a
 * Mongo y las semillas corren en paralelo; mongoose encola las consultas hasta conectar.
 */
async function bootstrap() {
  try {
    if (!(await dbConnect())) return; // sin base no se siembra; el middleware reintenta en cada solicitud
    const userService = new UserService();
    await userService.seedInitialUsers();
    await seedBranches();
    await seedSellers();
  } catch (error) {
    console.error("❌ Error al conectar o sembrar datos iniciales:", error);
  }
}

function main() {
  const { server } = createApp();
  server.timeout = 10 * 60 * 1000;
  const port: number | string = process.env.PORT || 8100;
  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
  void bootstrap();
}

main();
