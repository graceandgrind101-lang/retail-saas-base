import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnchorExistsError,
  MemoryAnchorStore,
  anchorAllTenants,
  anchorKey,
  type AnchorDocument,
} from "../src/jobs/anchor";
import { R2AnchorStore } from "../src/jobs/r2-store";
import { adminSql, createTenant, newId } from "./helpers";
import { createSecuredTable, dropTables } from "./probe-tables";
import { asRogueDba, rewriteHistoryFrom } from "./tamper";

const admin: Sql = adminSql(2);

await dropTables(admin, "anchor_probe");
await createSecuredTable(admin, "anchor_probe", "label text");

afterAll(async () => {
  await dropTables(admin, "anchor_probe");
  await admin.end();
});

const newTenant = (prefix: string) => createTenant(admin, `${prefix}-${randomBytes(4).toString("hex")}`);

async function addEntries(tenant: string, count: number) {
  for (let i = 0; i < count; i++) {
    await admin`insert into app.anchor_probe (id, tenant_id, label) values (${newId()}, ${tenant}, ${`row ${i}`})`;
  }
}

const headOf = async (tenant: string) =>
  (await admin<{ seq: number; hash: string }[]>`select seq::int as seq, hash from audit.log where tenant_id = ${tenant} order by seq desc limit 1`)[0];

const anchorRows = (tenant: string) =>
  admin<{ seq: number; hash: string; object_key: string }[]>`select seq::int as seq, hash, object_key from audit.anchors where tenant_id = ${tenant} order by seq`;

describe("anchoring a chain head outside the database", () => {
  it("anchors every tenant that has entries, recording exactly the verified head", async () => {
    const a = await newTenant("anc-a");
    const b = await newTenant("anc-b");
    await addEntries(a, 4);
    await addEntries(b, 7);
    const store = new MemoryAnchorStore();

    const report = await anchorAllTenants(admin, store, { tenantIds: [a, b] });

    expect(report.failures).toEqual([]);
    expect(report.anchored.map((x) => [x.tenantId, x.seq]).sort()).toEqual(
      [
        [a, 4],
        [b, 7],
      ].sort(),
    );
    expect(store.objects.size).toBe(2);

    for (const [tenant, seq] of [[a, 4], [b, 7]] as const) {
      const head = await headOf(tenant);
      const document = JSON.parse(store.objects.get(anchorKey(tenant, seq)) ?? "{}") as AnchorDocument;
      expect(document).toMatchObject({ version: 1, tenantId: tenant, seq, hash: head?.hash });
      expect(document.anchoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await anchorRows(tenant)).toEqual([{ seq, hash: head?.hash, object_key: anchorKey(tenant, seq) }]);
    }
  });

  it("does nothing when there is nothing new", async () => {
    const tenant = await newTenant("anc-idem");
    await addEntries(tenant, 3);
    const store = new MemoryAnchorStore();
    await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    const again = await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    expect(again).toEqual({ anchored: [], unchanged: 1, failures: [] });
    expect(store.objects.size).toBe(1);
    expect(await anchorRows(tenant)).toHaveLength(1);
  });

  it("adds a newer anchor after new entries and keeps the old ones", async () => {
    const tenant = await newTenant("anc-grow");
    await addEntries(tenant, 3);
    const store = new MemoryAnchorStore();
    await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    await addEntries(tenant, 2);
    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    expect(report.anchored).toEqual([{ tenantId: tenant, seq: 5, key: anchorKey(tenant, 5) }]);
    expect([...store.objects.keys()].sort()).toEqual([anchorKey(tenant, 3), anchorKey(tenant, 5)]);
    expect((await anchorRows(tenant)).map((r) => r.seq)).toEqual([3, 5]);
  });

  it("refuses to anchor a chain that does not verify, and stores nothing", async () => {
    const tenant = await newTenant("anc-broken");
    await addEntries(tenant, 6);
    await asRogueDba(admin, () => admin`update audit.log set after_data = jsonb_set(after_data, '{label}', '"x"') where tenant_id = ${tenant} and seq = 3`);
    const store = new MemoryAnchorStore();

    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });

    expect(report.anchored).toEqual([]);
    expect(report.failures).toEqual([{ tenantId: tenant, reason: expect.stringContaining("chain is broken at seq 3") }]);
    expect(store.objects.size).toBe(0);
    expect(await anchorRows(tenant)).toEqual([]);
  });

  it("raises the alarm when the newest entries were deleted after an anchor", async () => {
    const tenant = await newTenant("anc-tail");
    await addEntries(tenant, 8);
    const store = new MemoryAnchorStore();
    await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    await asRogueDba(admin, () => admin`delete from audit.log where tenant_id = ${tenant} and seq >= 7`);

    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });

    expect(report.failures).toEqual([{ tenantId: tenant, reason: expect.stringContaining("removed") }]);
    expect(report.anchored).toEqual([]);
  });

  it("raises the alarm when the whole history was rewritten, even if the chain still verifies", async () => {
    const tenant = await newTenant("anc-rewrite");
    await addEntries(tenant, 8);
    const store = new MemoryAnchorStore();
    await anchorAllTenants(admin, store, { tenantIds: [tenant] });

    await rewriteHistoryFrom(admin, tenant, 3);
    const [chain] = await admin<{ ok: boolean }[]>`select ok from audit.verify_chain(${tenant})`;
    expect(chain?.ok, "the forgery is perfect: the chain alone cannot tell").toBe(true);

    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    expect(report.failures).toEqual([{ tenantId: tenant, reason: expect.stringContaining("rewritten") }]);
  });

  it("does not anchor new entries on top of a history that was already rewritten", async () => {
    const tenant = await newTenant("anc-rewrite-then-grow");
    await addEntries(tenant, 5);
    const store = new MemoryAnchorStore();
    await anchorAllTenants(admin, store, { tenantIds: [tenant] });
    await rewriteHistoryFrom(admin, tenant, 2);
    await addEntries(tenant, 2);

    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });

    expect(report.anchored).toEqual([]);
    expect(report.failures[0]?.reason).toContain("no longer matches the log");
    expect(await anchorRows(tenant)).toHaveLength(1); // only the honest one from before
  });

  it("recovers when a previous run stored the object but died before recording it", async () => {
    const tenant = await newTenant("anc-recover");
    await addEntries(tenant, 4);
    const head = await headOf(tenant);
    const store = new MemoryAnchorStore();
    await store.put(anchorKey(tenant, 4), JSON.stringify({ version: 1, tenantId: tenant, seq: 4, hash: head?.hash, anchoredAt: "earlier" }));

    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });

    expect(report.failures).toEqual([]);
    expect(report.anchored).toHaveLength(1);
    expect(await anchorRows(tenant)).toHaveLength(1);
  });

  it("raises the alarm when the object store already holds a DIFFERENT anchor for that position", async () => {
    const tenant = await newTenant("anc-conflict");
    await addEntries(tenant, 4);
    const store = new MemoryAnchorStore();
    await store.put(anchorKey(tenant, 4), JSON.stringify({ version: 1, tenantId: tenant, seq: 4, hash: "0".repeat(64), anchoredAt: "x" }));

    const report = await anchorAllTenants(admin, store, { tenantIds: [tenant] });

    expect(report.failures).toEqual([{ tenantId: tenant, reason: expect.stringContaining("DIFFERENT anchor") }]);
    expect(await anchorRows(tenant)).toEqual([]);
  });

  it("fails loudly, and records nothing, when the object store is unreachable", async () => {
    const tenant = await newTenant("anc-down");
    await addEntries(tenant, 3);
    const down = {
      put: async () => {
        throw new Error("store unreachable");
      },
      get: async () => null,
    };
    await expect(anchorAllTenants(admin, down, { tenantIds: [tenant] })).rejects.toThrow("store unreachable");
    expect(await anchorRows(tenant)).toEqual([]); // never claim an anchor that was not stored
  });

  it("only touches the tenants it was asked about", async () => {
    const mine = await newTenant("anc-scope-a");
    const other = await newTenant("anc-scope-b");
    await addEntries(mine, 2);
    await addEntries(other, 2);
    const report = await anchorAllTenants(admin, new MemoryAnchorStore(), { tenantIds: [mine] });
    expect(report.anchored.map((a) => a.tenantId)).toEqual([mine]);
    expect(await anchorRows(other)).toEqual([]);
  });

  it("ignores tenants that have no entries", async () => {
    const empty = await newTenant("anc-empty");
    const report = await anchorAllTenants(admin, new MemoryAnchorStore(), { tenantIds: [empty] });
    expect(report).toEqual({ anchored: [], unchanged: 0, failures: [] });
  });

  it("anchor keys sort in sequence order", () => {
    const t = "018f0000-0000-7000-8000-000000000001";
    const keys = [100, 9, 10, 2].map((seq) => anchorKey(t, seq));
    expect([...keys].sort()).toEqual([2, 9, 10, 100].map((seq) => anchorKey(t, seq)));
  });
});

describe("MemoryAnchorStore", () => {
  it("never overwrites", async () => {
    const store = new MemoryAnchorStore();
    await store.put("k", "one");
    await expect(store.put("k", "two")).rejects.toThrow(AnchorExistsError);
    expect(await store.get("k")).toBe("one");
    expect(await store.get("missing")).toBeNull();
  });
});

// The real R2 is not available yet, so the store is checked against a local server that
// behaves like R2's S3 API: it records exactly what it was sent, and answers as scripted.
describe("R2AnchorStore (against a local stand-in for R2)", () => {
  interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
  }
  let server: Server;
  let endpoint = "";
  let seen: Seen[] = [];
  let reply: { status: number; body?: string } = { status: 200 };
  let queue: { status: number; body?: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        const next = queue.shift() ?? reply;
        response.statusCode = next.status;
        response.end(next.body ?? "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const store = (retries = 0) =>
    new R2AnchorStore({ endpoint: `${endpoint}/`, bucket: "audit-anchors", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-key-example", retries });
  const reset = (next: { status: number; body?: string }, scripted: { status: number; body?: string }[] = []) => {
    seen = [];
    reply = next;
    queue = [...scripted];
  };

  it("PUTs a signed, write-once request to the bucket path", async () => {
    reset({ status: 200 });
    await store().put("anchors/t1/000000000005.json", '{"hello":"world"}');

    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe("/audit-anchors/anchors/t1/000000000005.json");
    expect(request?.body).toBe('{"hello":"world"}');
    expect(request?.headers["if-none-match"]).toBe("*"); // never overwrite
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(request?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*if-none-match/);
    expect(request?.headers.authorization).not.toContain("secret-key-example");
  });

  it("treats HTTP 412 as 'already exists'", async () => {
    reset({ status: 412 });
    await expect(store().put("k", "v")).rejects.toThrow(AnchorExistsError);
  });

  it("reports any other failure with the status", async () => {
    reset({ status: 500 });
    await expect(store(0).put("k", "v")).rejects.toThrow(/HTTP 500/);
    expect(seen).toHaveLength(1);
  });

  it("retries a transient server error and then succeeds", async () => {
    reset({ status: 200 }, [{ status: 503 }, { status: 503 }]);
    await store(3).put("k", "v");
    expect(seen).toHaveLength(3); // two failures, then the success
  });

  it("gives up after the configured number of retries", async () => {
    reset({ status: 503 });
    await expect(store(2).put("k", "v")).rejects.toThrow(/HTTP 503/);
    expect(seen).toHaveLength(3); // the first try plus two retries
  });

  it("a retry that finds the object already there (reply was lost) is reported as 'already exists'", async () => {
    reset({ status: 200 }, [{ status: 503 }, { status: 412 }]);
    await expect(store(3).put("k", "v")).rejects.toThrow(AnchorExistsError);
  });

  it("GET returns the body, or null for a missing object", async () => {
    reset({ status: 200, body: '{"seq":5}' });
    expect(await store().get("anchors/t1/5.json")).toBe('{"seq":5}');
    expect(seen[0]?.method).toBe("GET");
    reset({ status: 404 });
    expect(await store().get("anchors/t1/6.json")).toBeNull();
    reset({ status: 403 });
    await expect(store().get("x")).rejects.toThrow(/HTTP 403/);
  });

  it("needs an account id or an endpoint", () => {
    expect(() => new R2AnchorStore({ bucket: "b", accessKeyId: "a", secretAccessKey: "s" })).toThrow(/accountId or an endpoint/);
  });

  it("builds the Cloudflare endpoint from the account id", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      await new R2AnchorStore({ accountId: "abc123", bucket: "bkt", accessKeyId: "a", secretAccessKey: "s" }).put("k.json", "{}");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual(["https://abc123.r2.cloudflarestorage.com/bkt/k.json"]);
  });
});

describe("the nightly command", () => {
  it("refuses to run without its settings, naming each one and printing no value", () => {
    const secret = "supersecretpassword123";
    const result = spawnSync("pnpm", ["exec", "tsx", "src/bin/anchor-audit.ts"], {
      shell: true,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: `postgresql://postgres:${secret}@127.0.0.1:1/postgres`,
        R2_ACCOUNT_ID: "",
        R2_BUCKET: "",
        R2_ACCESS_KEY_ID: "",
        R2_SECRET_ACCESS_KEY: "",
      },
    });
    expect(result.status).toBe(1);
    for (const name of ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
      expect(result.stderr).toContain(name);
    }
    expect(result.stderr + result.stdout).not.toContain(secret);
  }, 60_000);
});
