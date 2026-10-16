import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64url, utf8Bytes } from "./encoding";
import { parseCookieHeader, readSessionCookie, signSessionCookie, type SessionCookiePayload } from "./session-cookie";
import { randomInt, seededRandom } from "./testing";

const SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";
const OTHER_SECRET = "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b";
const NOW = 1_800_000_000;

const payload: SessionCookiePayload = {
  tenantId: "018f0000-0000-7000-8000-000000000001",
  staffId: "018f0000-0000-7000-8000-0000000000a1",
  sessionId: "018f0000-0000-7000-8000-0000000000b1",
  expiresAt: NOW + 3600,
};

/** Sign ANY json body with Node's own HMAC: an independent implementation, and a way to craft well-signed junk. */
function craft(body: unknown, secret = SECRET): string {
  const encoded = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}
const good = { v: 1, t: payload.tenantId, s: payload.staffId, i: payload.sessionId, e: payload.expiresAt };

describe("signSessionCookie / readSessionCookie", () => {
  it("round-trips", async () => {
    const cookie = await signSessionCookie(payload, SECRET);
    expect(await readSessionCookie(cookie, SECRET, NOW)).toEqual(payload);
  });

  it("produces exactly what an independent HMAC-SHA256 produces (so it is a standard signature)", async () => {
    expect(await signSessionCookie(payload, SECRET)).toBe(craft(good));
  });

  it("has the shape body.signature, URL-safe, with a 32-byte signature", async () => {
    const cookie = await signSessionCookie(payload, SECRET);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });

  it("is refused after it expires, including in the very second it expires", async () => {
    const cookie = await signSessionCookie(payload, SECRET);
    expect(await readSessionCookie(cookie, SECRET, payload.expiresAt - 1)).not.toBeNull();
    expect(await readSessionCookie(cookie, SECRET, payload.expiresAt)).toBeNull();
    expect(await readSessionCookie(cookie, SECRET, payload.expiresAt + 1)).toBeNull();
  });

  it("is refused with a different secret", async () => {
    expect(await readSessionCookie(await signSessionCookie(payload, SECRET), OTHER_SECRET, NOW)).toBeNull();
  });

  it("is refused if the body is altered, even by one character", async () => {
    const cookie = await signSessionCookie(payload, SECRET);
    const [body, signature] = cookie.split(".") as [string, string];
    for (let i = 0; i < body.length; i += 7) {
      const swapped = body[i] === "A" ? "B" : "A";
      expect(await readSessionCookie(`${body.slice(0, i)}${swapped}${body.slice(i + 1)}.${signature}`, SECRET, NOW)).toBeNull();
    }
  });

  it("is refused if the signature is altered, truncated or swapped from another cookie", async () => {
    const cookie = await signSessionCookie(payload, SECRET);
    const [body, signature] = cookie.split(".") as [string, string];
    const other = (await signSessionCookie({ ...payload, staffId: "018f0000-0000-7000-8000-0000000000a2" }, SECRET)).split(".")[1] ?? "";
    for (const bad of [signature.slice(1), `${signature}A`, `A${signature.slice(1)}`, other, "", "A".repeat(43)]) {
      expect(await readSessionCookie(`${body}.${bad}`, SECRET, NOW)).toBeNull();
    }
  });

  it.each(["", ".", "..", "abc", "abc.def.ghi", "a.b", "not base64!.AAAA", "e30.e30"])("refuses the malformed cookie %j without throwing", async (cookie) => {
    expect(await readSessionCookie(cookie, SECRET, NOW)).toBeNull();
  });

  it("never throws on random garbage", async () => {
    const next = seededRandom(5);
    const alphabet = "abcXYZ0189-_.= ";
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: randomInt(next, 0, 120) }, () => alphabet[randomInt(next, 0, alphabet.length - 1)]).join("");
      expect(await readSessionCookie(text, SECRET, NOW)).toBeNull();
    }
  });

  describe("a cookie that is correctly signed but wrong inside is still refused", () => {
    it("accepts the crafted baseline (so the cases below fail for the reason claimed)", async () => {
      expect(await readSessionCookie(craft(good), SECRET, NOW)).toEqual(payload);
    });

    it.each([
      ["an unknown version", { ...good, v: 2 }],
      ["no version", { t: good.t, s: good.s, i: good.i, e: good.e }],
      ["an extra field", { ...good, admin: true }],
      ["a missing field", { v: 1, t: good.t, s: good.s, e: good.e }],
      ["a tenant that is not a uuid", { ...good, t: "tenant-1" }],
      ["a staff id that is not a uuid", { ...good, s: 5 }],
      ["a session id that is not a uuid", { ...good, i: `${good.i}x` }],
      ["an expiry that is a string", { ...good, e: String(good.e) }],
      ["a fractional expiry", { ...good, e: good.e + 0.5 }],
      ["an expiry in the past", { ...good, e: NOW - 1 }],
      ["a JSON array", [good]],
      ["JSON null", null],
      ["a JSON string", "text"],
    ])("%s", async (_label, body) => {
      expect(await readSessionCookie(craft(body), SECRET, NOW)).toBeNull();
    });

    it("body that is not JSON, or not valid UTF-8", async () => {
      expect(await readSessionCookie(craft("not json at all"), SECRET, NOW)).toBeNull();
      const bytes = Uint8Array.of(0xff, 0xfe, 0xfd);
      const encoded = base64url(bytes);
      const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");
      expect(await readSessionCookie(`${encoded}.${signature}`, SECRET, NOW)).toBeNull();
    });
  });

  it("refuses to sign with a weak secret, and refuses to accept anything made with one", async () => {
    await expect(signSessionCookie(payload, "short")).rejects.toThrow(/at least 32/);
    expect(await readSessionCookie(craft(good, "short"), "short", NOW)).toBeNull();
  });

  it("refuses to sign ids that are not UUIDs or an expiry that is not whole seconds", async () => {
    await expect(signSessionCookie({ ...payload, tenantId: "x" }, SECRET)).rejects.toThrow(TypeError);
    await expect(signSessionCookie({ ...payload, staffId: "x" }, SECRET)).rejects.toThrow(TypeError);
    await expect(signSessionCookie({ ...payload, sessionId: "x" }, SECRET)).rejects.toThrow(TypeError);
    await expect(signSessionCookie({ ...payload, expiresAt: 1.5 }, SECRET)).rejects.toThrow(TypeError);
    await expect(signSessionCookie({ ...payload, expiresAt: Number.NaN }, SECRET)).rejects.toThrow(TypeError);
  });

  it("works with a secret containing non-ASCII characters", async () => {
    const secret = "ሰላም-ዓለም-secret-with-unicode-0123456789";
    const cookie = await signSessionCookie(payload, secret);
    expect(await readSessionCookie(cookie, secret, NOW)).toEqual(payload);
    expect(cookie.split(".")[1]).toBe(createHmac("sha256", Buffer.from(secret, "utf8")).update(cookie.split(".")[0] ?? "").digest("base64url"));
    expect(utf8Bytes(secret).length).toBeGreaterThan(secret.length);
  });
});

describe("parseCookieHeader", () => {
  it("parses ordinary headers", () => {
    expect(parseCookieHeader("a=1; b=2;c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns nothing for a missing or empty header", () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("keeps '=' inside a value (base64 padding, our own dots) and unquotes quoted values", () => {
    expect(parseCookieHeader("s=abc.def==; q=\"hello world\"")).toEqual({ s: "abc.def==", q: "hello world" });
  });

  it("ignores malformed pairs, and the first of a repeated name wins (a later one cannot override it)", () => {
    expect(parseCookieHeader("novalue; =x; a=1; a=2; ;; b=")).toEqual({ a: "1", b: "" });
  });

  it("is not fooled by a name that merely ends with ours", () => {
    expect(parseCookieHeader("evil_session=forged; session=real")).toEqual({ evil_session: "forged", session: "real" });
  });
});
