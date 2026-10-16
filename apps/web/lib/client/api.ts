/** Calls to our own API from the browser. The browser adds the Origin header itself, which the server checks. */
export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  /** The JSON body; on failure it holds a short error code (see the `errors` messages). Empty if the server sent nothing readable. */
  data: T & { error?: string };
}

export async function postJson<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as ApiResult<T>["data"];
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } as ApiResult<T>["data"] };
  }
}

/** End this sign-in on the server (the cookie is forgotten too). Never throws. */
export async function signOutOnServer(): Promise<void> {
  await postJson("/api/auth/signout");
}
