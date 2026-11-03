/**
 * Lectura del CRM (HighLevel / LeadConnector) de Nicole y Sucrée para el conector MCP.
 * Cada marca es una subcuenta distinta con su propio token. Credenciales solo por entorno
 * (el repo es público):
 *   - Nicole: HIGHLEVEL_PIT + HIGHLEVEL_LOCATION_ID
 *   - Sucrée: HIGHLEVEL_SUCREE_PIT + HIGHLEVEL_SUCREE_LOCATION_ID
 * Solo GET/búsquedas: nada se escribe.
 */
const BASE = "https://services.leadconnectorhq.com";

export type CrmAccount = "nicole" | "sucree";
export const CRM_LABEL: Record<CrmAccount, string> = { nicole: "Nicole", sucree: "Sucrée" };

const creds = (acc: CrmAccount) =>
  acc === "sucree"
    ? { pit: process.env.HIGHLEVEL_SUCREE_PIT, location: process.env.HIGHLEVEL_SUCREE_LOCATION_ID }
    : { pit: process.env.HIGHLEVEL_PIT, location: process.env.HIGHLEVEL_LOCATION_ID };

export const hlConfigured = (acc: CrmAccount = "nicole") => {
  const c = creds(acc);
  return !!(c.pit && c.location);
};
/** Cuentas con credenciales cargadas. */
export const configuredAccounts = (): CrmAccount[] => (["nicole", "sucree"] as CrmAccount[]).filter((a) => hlConfigured(a));
export const locationId = (acc: CrmAccount = "nicole") => String(creds(acc).location || "");

export async function hl<T = any>(acc: CrmAccount, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  if (!hlConfigured(acc)) throw new Error(`El CRM de ${CRM_LABEL[acc]} no está configurado.`);
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || "GET",
    headers: {
      Authorization: `Bearer ${creds(acc).pit}`,
      Version: "2021-07-28",
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CRM ${CRM_LABEL[acc]} ${res.status}: ${data?.message || "error"}`);
  return data as T;
}

// Equipo y etapas cambian poco: caché de 10 minutos por instancia y por cuenta.
const usersCache: Partial<Record<CrmAccount, { at: number; map: Map<string, string> }>> = {};
export async function teamMap(acc: CrmAccount): Promise<Map<string, string>> {
  const c = usersCache[acc];
  if (c && Date.now() - c.at < 600_000) return c.map;
  const d = await hl<any>(acc, `/users/?locationId=${locationId(acc)}`);
  const map = new Map<string, string>((d.users || []).map((u: any) => [u.id, u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim()]));
  usersCache[acc] = { at: Date.now(), map };
  return map;
}

const pipeCache: Partial<Record<CrmAccount, { at: number; pipelines: any[] }>> = {};
export async function pipelines(acc: CrmAccount): Promise<any[]> {
  const c = pipeCache[acc];
  if (c && Date.now() - c.at < 600_000) return c.pipelines;
  const d = await hl<any>(acc, `/opportunities/pipelines?locationId=${locationId(acc)}`);
  pipeCache[acc] = { at: Date.now(), pipelines: d.pipelines || [] };
  return pipeCache[acc]!.pipelines;
}

export async function stageMap(acc: CrmAccount): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const list = await pipelines(acc);
  for (const p of list) for (const s of p.stages || []) map.set(s.id, `${s.name}${list.length > 1 ? ` (${p.name})` : ""}`);
  return map;
}

/** Busca el id de una persona del equipo por nombre (sin tildes ni mayúsculas). */
export async function userIdByName(acc: CrmAccount, name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = norm(name);
  for (const [id, n] of await teamMap(acc)) if (norm(n).includes(needle)) return id;
  return undefined;
}

/** Fecha de Ecuador "AAAA-MM-DD HH:mm" desde ms o ISO. */
export function ec(d: unknown): string | null {
  if (d === undefined || d === null || d === "") return null;
  const n = typeof d === "number" || /^\d+$/.test(String(d)) ? Number(d) : Date.parse(String(d));
  if (!Number.isFinite(n)) return null;
  return new Date(n - 5 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
