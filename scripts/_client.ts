/** 스크립트 공용 HTTP 클라이언트. SOMUN_URL(기본 http://localhost:8790), SOMUN_TOKEN(선택). */
const base = (process.env.SOMUN_URL ?? "http://localhost:8790").replace(/\/+$/, "");
const token = process.env.SOMUN_TOKEN;

export async function call<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status} ${path}`);
  return data;
}
