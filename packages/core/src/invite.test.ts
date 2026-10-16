import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, isSystemRoleKey, SESSION_HOURS } from "./roles";
import { base64url } from "./encoding";
import { INVITE_TOKEN_BYTES, generateInviteToken, hashInviteToken, isWellFormedInviteToken } from "./invite";

describe("base64url", () => {
  it("matches Node's own encoder for every length from 0 to 40 bytes", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 0xff);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("uses the URL-safe alphabet and no padding", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encoded = base64url(all);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(encoded).toBe(Buffer.from(all).toString("base64url"));
  });
});

describe("generateInviteToken", () => {
  it("is 43 URL-safe characters (32 bytes) and passes its own shape check", () => {
    const token = generateInviteToken();
    expect(token).toHaveLength(43);
    expect(isWellFormedInviteToken(token)).toBe(true);
    expect(INVITE_TOKEN_BYTES).toBe(32);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 5_000 }, () => generateInviteToken()));
    expect(tokens.size).toBe(5_000);
  });

  it("uses the supplied randomness, so a test can pin it", () => {
    expect(generateInviteToken((bytes) => bytes.fill(0))).toBe("A".repeat(43));
    expect(generateInviteToken((bytes) => bytes.fill(255))).toBe(Buffer.alloc(32, 255).toString("base64url"));
  });
});

describe("isWellFormedInviteToken", () => {
  it.each(["", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}!`, `${"A".repeat(42)} `, "A".repeat(42) + "=", "é".repeat(43)])(
    "rejects %j",
    (token) => {
      expect(isWellFormedInviteToken(token)).toBe(false);
    },
  );

  it("accepts the full alphabet", () => {
    expect(isWellFormedInviteToken("A".repeat(41) + "_-")).toBe(true);
    expect(isWellFormedInviteToken("0123456789abcdefghijklmnopqrstuvwxyzABCDEFG")).toBe(true);
  });
});

describe("hashInviteToken", () => {
  it("is the lowercase hex SHA-256 of the token", async () => {
    const token = generateInviteToken();
    expect(await hashInviteToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("is deterministic, 64 hex characters, and differs for different tokens", async () => {
    const a = await hashInviteToken("A".repeat(43));
    expect(a).toBe(await hashInviteToken("A".repeat(43)));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await hashInviteToken("B".repeat(43)));
  });

  it("does not equal the token (the token is never what is stored)", async () => {
    const token = generateInviteToken();
    expect(await hashInviteToken(token)).not.toContain(token);
  });
});

describe("system roles and sessions", () => {
  it("every system role has a name in English and Amharic", () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      expect(SYSTEM_ROLES[key].name.en).toBeTruthy();
      expect(SYSTEM_ROLES[key].name.am).toBeTruthy();
    }
  });

  it("role keys are unique and well formed (the database checks the same pattern)", () => {
    expect(new Set(SYSTEM_ROLE_KEYS).size).toBe(SYSTEM_ROLE_KEYS.length);
    for (const key of SYSTEM_ROLE_KEYS) expect(key).toMatch(/^[a-z][a-z_]*$/);
    expect(isSystemRoleKey("owner")).toBe(true);
    expect(isSystemRoleKey("admin")).toBe(false);
  });

  it("a till session is shorter than an admin session", () => {
    expect(SESSION_HOURS.pos).toBe(12);
    expect(SESSION_HOURS.admin).toBeGreaterThan(SESSION_HOURS.pos);
  });
});
