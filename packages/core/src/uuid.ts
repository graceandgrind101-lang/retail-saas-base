/**
 * UUIDv7 (RFC 9562): 48-bit Unix-millisecond timestamp, then random bits. Ids are generated
 * on the device so an offline sale already has its final id; replaying it later is a no-op
 * (DATA_MODEL S9). Time-ordered ids also keep database indexes compact.
 *
 * Ids made by one generator are strictly increasing, even within the same millisecond or if
 * the clock steps backwards: a 12-bit counter in `rand_a` breaks ties, and on overflow the
 * timestamp is advanced by 1 ms.
 *
 * Randomness and the clock are injectable for tests. The default uses
 * `crypto.getRandomValues`, which exists in browsers, Node and Workers, and throws if it is
 * missing: ids are never made from `Math.random`.
 */

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

export interface UuidV7Options {
  /** Milliseconds since the Unix epoch. Defaults to `Date.now`. */
  now?: () => number;
  random?: RandomFill;
}

const MAX_TIMESTAMP = 0xffff_ffff_ffff; // 48 bits
const MAX_COUNTER = 0xfff; // 12 bits
const COUNTER_START_MASK = 0x7ff; // start below the top so there is headroom to count up

/** Fill `bytes` from the platform's secure random source, or throw: never `Math.random`. */
export function secureRandom(bytes: Uint8Array): Uint8Array {
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!source?.getRandomValues) {
    throw new Error("No secure random source (crypto.getRandomValues) available to generate ids");
  }
  return source.getRandomValues(bytes);
}

export function createUuidV7Generator(options: UuidV7Options = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? secureRandom;

  let lastMs = -1;
  let counter = 0;

  return () => {
    const entropy = random(new Uint8Array(10));
    const startCounter = (((entropy[8] ?? 0) << 8) | (entropy[9] ?? 0)) & COUNTER_START_MASK;

    const clock = Math.floor(now());
    if (!Number.isSafeInteger(clock) || clock < 0 || clock > MAX_TIMESTAMP) {
      throw new RangeError(`UUIDv7: timestamp out of range (${clock})`);
    }

    if (clock > lastMs) {
      lastMs = clock;
      counter = startCounter;
    } else {
      // Same millisecond, or the clock went backwards: keep the later time and count up.
      counter += 1;
      if (counter > MAX_COUNTER) {
        lastMs += 1;
        counter = startCounter;
      }
    }
    if (lastMs > MAX_TIMESTAMP) throw new RangeError("UUIDv7: timestamp overflow");

    const bytes = new Uint8Array(16);
    let ms = lastMs;
    for (let i = 5; i >= 0; i--) {
      bytes[i] = ms % 256;
      ms = Math.floor(ms / 256);
    }
    bytes[6] = 0x70 | (counter >> 8); // version 7 + top 4 bits of rand_a
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | ((entropy[0] ?? 0) & 0x3f); // variant 10 + 6 bits of rand_b
    for (let i = 1; i <= 7; i++) bytes[8 + i] = entropy[i] ?? 0;

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** The shared generator. Ids from this one are strictly increasing within this process. */
export const uuidv7: () => string = createUuidV7Generator();

const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a well-formed RFC 9562 UUID of any version 1-8 (not the nil or max UUID). */
export function isUuid(value: string): boolean {
  return ANY_UUID.test(value);
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** The creation time (ms since epoch) encoded in a UUIDv7. Throws if `id` is not one. */
export function uuidV7Timestamp(id: string): number {
  if (!isUuidV7(id)) throw new TypeError("uuidV7Timestamp: not a UUIDv7");
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
