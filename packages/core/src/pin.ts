import { base64url, base64urlDecode, utf8Bytes } from "./encoding";
import { secureRandom, type RandomFill } from "./uuid";

/**
 * PINs, pairing codes and device tokens (Phase A task A8). Pure rules: the database stores what
 * these functions produce, and the server decides what to do with the answers.
 *
 * PIN storage: `HMAC-SHA256(pepper, pin)` is fed into PBKDF2-SHA256 with a random salt. The pepper
 * lives only in the server's environment, so a stolen database alone cannot be brute-forced (a
 * 4-6 digit PIN has too few possibilities to survive that); the slow hash makes guessing costly
 * even for someone holding both. Iterations are stored in the hash string so they can be raised later.
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
/** Cloudflare Workers refuse PBKDF2 above 100,000 iterations, and we must run there (ADR-001). */
export const PIN_PBKDF2_ITERATIONS = 100_000;
const MAX_STORED_ITERATIONS = 1_000_000;
const SALT_BYTES = 16;

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_MINUTES = 15;
/** A step-up proof ("a manager typed their PIN for this one action") is single-use and short-lived. */
export const STEP_UP_VALID_SECONDS = 120;
export const PAIRING_CODE_VALID_MINUTES = 10;

export type PinProblem = "not_digits" | "too_short" | "too_long" | "too_easy";

/**
 * Is this an acceptable new PIN? Refuses what a thief would try first: one repeated digit
 * (0000) and straight runs (1234, 4321). Returns the problem, or null when fine.
 */
export function checkNewPin(pin: string): PinProblem | null {
  if (!/^[0-9]*$/.test(pin)) return "not_digits";
  if (pin.length < PIN_MIN_LENGTH) return "too_short";
  if (pin.length > PIN_MAX_LENGTH) return "too_long";
  const digits = Array.from(pin, Number);
  const steps = digits.slice(1).map((d, i) => d - (digits[i] as number));
  if (steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1)) return "too_easy";
  return null;
}

/** Shape check for a PIN being ENTERED (login): cheap, and says nothing about whether it is right. */
export function isPinShape(pin: string): boolean {
  return /^[0-9]+$/.test(pin) && pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH;
}

interface SubtleLike {
  importKey(format: "raw", key: Uint8Array, algorithm: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  deriveBits(algorithm: unknown, key: unknown, length: number): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike {
  const s = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!s) throw new Error("No Web Crypto (crypto.subtle) available");
  return s;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const s = subtle();
  const key = await s.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await s.sign("HMAC", key, utf8Bytes(message)));
}

/** Lowercase hex HMAC-SHA256 of `message` under `secret`: how pairing codes and device tokens are stored. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  return Array.from(await hmac(secret, message), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function derive(pin: string, pepper: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const s = subtle();
  const material = await hmac(pepper, pin);
  const key = await s.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await s.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`. Does NOT check the PIN's strength: call `checkNewPin` first. */
export async function hashPin(
  pin: string,
  pepper: string,
  options: { iterations?: number; random?: RandomFill } = {},
): Promise<string> {
  const iterations = options.iterations ?? PIN_PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_STORED_ITERATIONS) {
    throw new Error("PIN hash iterations out of range");
  }
  if (pepper.length < 32) throw new Error("PIN pepper too short");
  const salt = (options.random ?? secureRandom)(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, pepper, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${base64url(salt)}$${base64url(hash)}`;
}

/** True only for the right PIN. Anything malformed (including an absurd iteration count) is simply false. */
export async function verifyPin(pin: string, stored: string, pepper: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!/^[0-9]+$/.test(parts[1] as string) || iterations < 1 || iterations > MAX_STORED_ITERATIONS) return false;
  const salt = base64urlDecode(parts[2] as string);
  const expected = base64urlDecode(parts[3] as string);
  if (!salt || !expected || salt.length !== SALT_BYTES || expected.length !== 32) return false;
  return sameBytes(await derive(pin, pepper, salt, iterations), expected);
}

// ---------- lockout ----------

export interface PinFailureState {
  failedCount: number;
  lockedUntil: Date | null;
}

export function isPinLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/**
 * State after a wrong PIN. The fifth failure in a row locks for 15 minutes and the counter starts
 * again; a failure while locked changes nothing (the caller refuses before checking the PIN anyway).
 */
export function afterPinFailure(state: PinFailureState, now: Date): PinFailureState {
  if (isPinLocked(state.lockedUntil, now)) return state;
  const failedCount = state.failedCount + 1;
  if (failedCount >= PIN_MAX_FAILURES) {
    return { failedCount: 0, lockedUntil: new Date(now.getTime() + PIN_LOCKOUT_MINUTES * 60_000) };
  }
  return { failedCount, lockedUntil: null };
}

/** A right PIN clears the count. */
export const afterPinSuccess = (): PinFailureState => ({ failedCount: 0, lockedUntil: null });

// ---------- pairing codes and device tokens ----------

/** 32 symbols, no 0/O or 1/I, so a code read aloud or off a screen is not misread. 32 divides 256: no bias. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;

/** A one-time code shown to the owner as a QR or `XXXX-XXXX`. 8 symbols = 40 bits; guesses are rate-limited and it lives 10 minutes. */
export function generatePairingCode(random: RandomFill = secureRandom): string {
  const bytes = random(new Uint8Array(PAIRING_CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

export const formatPairingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What a person typed, made comparable: upper case, no spaces or hyphens. Null if it cannot be a code. */
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const DEVICE_TOKEN_BYTES = 32;

/** The secret a paired device keeps. Only its HMAC (under DEVICE_TOKEN_PEPPER) is stored. */
export function generateDeviceToken(random: RandomFill = secureRandom): string {
  return base64url(random(new Uint8Array(DEVICE_TOKEN_BYTES)));
}

export const isWellFormedDeviceToken = (token: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(token);
