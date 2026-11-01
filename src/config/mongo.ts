import mongoose from "mongoose";

/**
 * Conexión a Mongo resistente para Vercel (serverless):
 * - `ensureDb()` se llama en CADA solicitud (middleware en app.ts): si la instancia quedó sin
 *   conexión (falló al arrancar o se cortó), la rehace en vez de quedar viva sin base. Antes,
 *   un fallo al conectar dejaba la instancia respondiendo "buffering timed out" para siempre.
 * - Pool chico: cada instancia de Vercel abre el suyo y Atlas tiene límite de conexiones.
 */
let pending: Promise<typeof mongoose> | null = null;

export async function ensureDb(): Promise<void> {
  const state = mongoose.connection.readyState; // 0 desconectado · 1 conectado · 2 conectando · 3 desconectando
  if (state === 1) return;
  if (state === 0 || state === 3) pending = null;
  if (!pending) {
    const uri = process.env.DB_URI;
    if (!uri) throw new Error("No mongo DB_URI");
    pending = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 45000, maxPoolSize: 10 })
      .catch((error) => {
        pending = null; // la próxima solicitud vuelve a intentar
        throw error;
      });
  }
  await pending;
}

async function dbConnect(): Promise<boolean> {
  try {
    await ensureDb();
    console.log("*** SUCCESSFULLY CONNECTED TO DATABASE NICOLE ORDER APP FRIENDDD  ***");
    return true;
  } catch (error) {
    console.log("*** CONECTION FAILED ***", error);
    return false;
  }
}

export default dbConnect;
