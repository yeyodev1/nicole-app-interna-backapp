/**
 * Lectura del CRM (HighLevel / LeadConnector) de Nicole para el conector MCP.
 * Credenciales solo por entorno (el repo es público): HIGHLEVEL_PIT (token de integración
 * privada) y HIGHLEVEL_LOCATION_ID (subcuenta). Solo GET/búsquedas: nada se escribe.
 */
const BASE = "https://services.leadconnectorhq.com";

export const hlConfigured = () => !!(process.env.HIGHLEVEL_PIT && process.env.HIGHLEVEL_LOCATION_ID);
export const locationId = () => String(process.env.HIGHLEVEL_LOCATION_ID || "");

export async function hl<T = any>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  if (!hlConfigured()) throw new Error("El CRM no está configurado (faltan HIGHLEVEL_PIT / HIGHLEVEL_LOCATION_ID).");
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || "GET",
    headers: {
      Authorization: `Bearer ${process.env.HIGHLEVEL_PIT}`,
      Version: "2021-07-28",
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CRM ${res.status}: ${data?.message || "error"}`);
  return data as T;
}

// Equipo y etapas cambian poco: caché de 10 minutos por instancia.
let usersCache: { at: number; map: Map<string, string> } | null = null;
export async function teamMap(): Promise<Map<string, string>> {
  if (usersCache && Date.now() - usersCache.at < 600_000) return usersCache.map;
  const d = await hl<any>(`/users/?locationId=${locationId()}`);
  const map = new Map<string, string>((d.users || []).map((u: any) => [u.id, u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim()]));
  usersCache = { at: Date.now(), map };
  return map;
}

let pipeCache: { at: number; pipelines: any[] } | null = null;
export async function pipelines(): Promise<any[]> {
  if (pipeCache && Date.now() - pipeCache.at < 600_000) return pipeCache.pipelines;
  const d = await hl<any>(`/opportunities/pipelines?locationId=${locationId()}`);
  pipeCache = { at: Date.now(), pipelines: d.pipelines || [] };
  return pipeCache.pipelines;
}

export async function stageMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const p of await pipelines()) for (const s of p.stages || []) map.set(s.id, `${s.name}${(await pipelines()).length > 1 ? ` (${p.name})` : ""}`);
  return map;
}

/** Busca el id de una persona del equipo por nombre (sin tildes ni mayúsculas). */
export async function userIdByName(name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = norm(name);
  for (const [id, n] of await teamMap()) if (norm(n).includes(needle)) return id;
  return undefined;
}

/** Fecha de Ecuador "AAAA-MM-DD HH:mm" desde ms o ISO. */
export function ec(d: unknown): string | null {
  if (d === undefined || d === null || d === "") return null;
  const n = typeof d === "number" || /^\d+$/.test(String(d)) ? Number(d) : Date.parse(String(d));
  if (!Number.isFinite(n)) return null;
  return new Date(n - 5 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
