import { createHmac, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_LENGTH,
  PIN_LOCKOUT_MINUTES,
  PIN_MAX_FAILURES,
  afterPinFailure,
  afterPinSuccess,
  checkNewPin,
  formatPairingCode,
  generateDeviceToken,
  generatePairingCode,
  hashPin,
  hmacHex,
  isPinLocked,
  isPinShape,
  isWellFormedDeviceToken,
  normalizePairingCode,
  verifyPin,
} from "./pin";

const PEPPER = "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b";
const OTHER_PEPPER = "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j";
const FAST = { iterations: 1000 };

describe("checkNewPin", () => {
  it("accepts ordinary 4 to 6 digit PINs", () => {
    for (const pin of ["4829", "73016", "908274", "1357", "2468", "1212"]) expect(checkNewPin(pin)).toBeNull();
  });
  it("refuses non-digits, wrong lengths", () => {
    expect(checkNewPin("12a4")).toBe("not_digits");
    expect(checkNewPin("12 4")).toBe("not_digits");
    expect(checkNewPin("١٢٣٤")).toBe("not_digits"); // Arabic-Indic digits are not accepted
    expect(checkNewPin("482")).toBe("too_short");
    expect(checkNewPin("")).toBe("too_short");
    expect(checkNewPin("4829017")).toBe("too_long");
  });
  it("refuses repeated digits and straight runs, up or down", () => {
    for (const pin of ["0000", "1111", "999999", "1234", "2345", "123456", "4321", "9876", "654321"]) {
      expect(checkNewPin(pin), pin).toBe("too_easy");
    }
  });
  it("does not over-refuse near misses", () => {
    for (const pin of ["1235", "1243", "1233", "12345 6".replace(" ", "")]) {
      expect(checkNewPin(pin) === "too_easy", pin).toBe(pin === "123456");
    }
  });
});

describe("isPinShape", () => {
  it("is about shape only (a weak PIN is still a PIN that can be entered)", () => {
    expect(isPinShape("0000")).toBe(true);
    expect(isPinShape("123456")).toBe(true);
    expect(isPinShape("123")).toBe(false);
    expect(isPinShape("1234567")).toBe(false);
    expect(isPinShape("12a4")).toBe(false);
    expect(isPinShape("1234\n")).toBe(false);
  });
});

describe("hashPin / verifyPin", () => {
  it("verifies the right PIN and nothing else", async () => {
    const stored = await hashPin("4829", PEPPER, FAST);
    expect(await verifyPin("4829", stored, PEPPER)).toBe(true);
    expect(await verifyPin("4828", stored, PEPPER)).toBe(false);
    expect(await verifyPin("", stored, PEPPER)).toBe(false);
    expect(await verifyPin("48290", stored, PEPPER)).toBe(false);
  });

  it("depends on the pepper: the same database row is useless under another pepper", async () => {
    const stored = await hashPin("4829", PEPPER, FAST);
    expect(await verifyPin("4829", stored, OTHER_PEPPER)).toBe(false);
  });

  it("salts: the same PIN hashes differently each time", async () => {
    const a = await hashPin("4829", PEPPER, FAST);
    const b = await hashPin("4829", PEPPER, FAST);
    expect(a).not.toBe(b);
    expect(await verifyPin("4829", a, PEPPER)).toBe(true);
    expect(await verifyPin("4829", b, PEPPER)).toBe(true);
  });

  it("matches an independent PBKDF2(HMAC(pepper, pin)) computation (golden vector)", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const stored = await hashPin("4829", PEPPER, { iterations: 2000, random: (bytes) => (bytes.set(salt), bytes) });
    const [scheme, iterations, saltText, hashText] = stored.split("$");
    expect(scheme).toBe("pbkdf2-sha256");
    expect(iterations).toBe("2000");
    expect(saltText).toBe(Buffer.from(salt).toString("base64url"));
    const material = createHmac("sha256", PEPPER).update("4829").digest();
    expect(hashText).toBe(pbkdf2Sync(material, Buffer.from(salt), 2000, 32, "sha256").toString("base64url"));
  });

  it("uses the iteration count stored in the hash, so raising the default later keeps old PINs working", async () => {
    const old = await hashPin("4829", PEPPER, { iterations: 1500 });
    expect(old.split("$")[1]).toBe("1500");
    expect(await verifyPin("4829", old, PEPPER)).toBe(true);
    // changing the stored count breaks it: the count is part of what is hashed
    expect(await verifyPin("4829", old.replace("$1500$", "$1501$"), PEPPER)).toBe(false);
  });

  it("defaults to 100,000 iterations (the most Cloudflare Workers allow)", async () => {
    expect((await hashPin("4829", PEPPER)).split("$")[1]).toBe("100000");
  });

  it("treats malformed stored values as 'wrong PIN', never as an error or a pass", async () => {
    const good = await hashPin("4829", PEPPER, FAST);
    const [scheme, iterations, salt, hash] = good.split("$") as [string, string, string, string];
    const bad = [
      "",
      "garbage",
      "$$$",
      `bcrypt$${iterations}$${salt}$${hash}`,
      `${scheme}$0$${salt}$${hash}`,
      `${scheme}$-5$${salt}$${hash}`,
      `${scheme}$1.5$${salt}$${hash}`,
      `${scheme}$1e3$${salt}$${hash}`,
      `${scheme}$99999999999$${salt}$${hash}`, // a hostile count must not make the server spin
      `${scheme}$${iterations}$${salt.slice(1)}$${hash}`,
      `${scheme}$${iterations}$${salt}$${hash.slice(1)}`,
      `${scheme}$${iterations}$${salt}$`,
      `${scheme}$${iterations}$$${hash}`,
      `${scheme}$${iterations}$${salt}$${hash}$extra`,
      `${scheme}$${iterations}$${salt}$${hash.slice(0, -1)}*`,
    ];
    for (const stored of bad) expect(await verifyPin("4829", stored, PEPPER), stored).toBe(false);
  });

  it("refuses to hash with a short pepper or silly iterations", async () => {
    await expect(hashPin("4829", "short")).rejects.toThrow(/pepper/);
    await expect(hashPin("4829", PEPPER, { iterations: 0 })).rejects.toThrow(/iterations/);
    await expect(hashPin("4829", PEPPER, { iterations: 2_000_000 })).rejects.toThrow(/iterations/);
    await expect(hashPin("4829", PEPPER, { iterations: 1.5 })).rejects.toThrow(/iterations/);
  });
});

describe("lockout", () => {
  const now = new Date("2026-10-16T10:00:00Z");

  it("counts failures and locks on the fifth in a row, for 15 minutes", () => {
    expect(PIN_MAX_FAILURES).toBe(5);
    expect(PIN_LOCKOUT_MINUTES).toBe(15);
    let state = afterPinSuccess();
    for (let i = 1; i <= 4; i++) {
      state = afterPinFailure(state, now);
      expect(state).toEqual({ failedCount: i, lockedUntil: null });
    }
    state = afterPinFailure(state, now);
    expect(state.lockedUntil).toEqual(new Date("2026-10-16T10:15:00Z"));
    expect(state.failedCount).toBe(0);
  });

  it("a failure during a lock changes nothing (it cannot extend or reset it)", () => {
    const locked = { failedCount: 0, lockedUntil: new Date("2026-10-16T10:15:00Z") };
    expect(afterPinFailure(locked, new Date("2026-10-16T10:05:00Z"))).toBe(locked);
  });

  it("is locked strictly before the end time, free at and after it", () => {
    const until = new Date("2026-10-16T10:15:00Z");
    expect(isPinLocked(until, new Date("2026-10-16T10:14:59.999Z"))).toBe(true);
    expect(isPinLocked(until, until)).toBe(false);
    expect(isPinLocked(until, new Date("2026-10-16T11:00:00Z"))).toBe(false);
    expect(isPinLocked(null, now)).toBe(false);
  });

  it("an expired lock lets counting start afresh", () => {
    const expired = { failedCount: 0, lockedUntil: new Date("2026-10-16T09:00:00Z") };
    expect(afterPinFailure(expired, now)).toEqual({ failedCount: 1, lockedUntil: null });
  });

  it("success clears everything", () => {
    expect(afterPinSuccess()).toEqual({ failedCount: 0, lockedUntil: null });
  });
});

describe("pairing codes", () => {
  it("are 8 characters from an alphabet without look-alikes", () => {
    for (let i = 0; i < 500; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    }
  });
  it("uses all 32 symbols evenly enough that no byte value is favoured", () => {
    const seen = new Set<string>();
    for (let b = 0; b < 256; b++) seen.add(generatePairingCode((bytes) => bytes.fill(b)).charAt(0));
    expect(seen.size).toBe(32);
  });
  it("never repeats in practice", () => {
    expect(new Set(Array.from({ length: 3000 }, () => generatePairingCode())).size).toBe(3000);
  });
  it("formats as XXXX-XXXX and normalizes what a person typed", () => {
    expect(formatPairingCode("ABCD2345")).toBe("ABCD-2345");
    expect(normalizePairingCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizePairingCode(" abcd 2345 ")).toBe("ABCD2345");
    expect(normalizePairingCode("ABCD2345")).toBe("ABCD2345");
  });
  it("rejects what cannot be a code", () => {
    for (const input of ["", "ABCD234", "ABCD23456", "ABCD-234O", "ABCD-2341", "ABCD-234!", "ABCD_2345"]) {
      expect(normalizePairingCode(input), input).toBeNull();
    }
  });
});

describe("device tokens", () => {
  it("are 43 URL-safe characters and unique", () => {
    const token = generateDeviceToken();
    expect(token).toHaveLength(43);
    expect(isWellFormedDeviceToken(token)).toBe(true);
    expect(new Set(Array.from({ length: 2000 }, () => generateDeviceToken())).size).toBe(2000);
  });
  it("shape check refuses junk", () => {
    expect(isWellFormedDeviceToken("short")).toBe(false);
    expect(isWellFormedDeviceToken("A".repeat(44))).toBe(false);
    expect(isWellFormedDeviceToken("A".repeat(42) + "=")).toBe(false);
  });
});

describe("hmacHex", () => {
  it("is HMAC-SHA256 as lowercase hex, matching Node", async () => {
    expect(await hmacHex(PEPPER, "ABCD2345")).toBe(createHmac("sha256", PEPPER).update("ABCD2345").digest("hex"));
  });
  it("differs by secret and by message", async () => {
    expect(await hmacHex(PEPPER, "a")).not.toBe(await hmacHex(OTHER_PEPPER, "a"));
    expect(await hmacHex(PEPPER, "a")).not.toBe(await hmacHex(PEPPER, "b"));
  });
});
