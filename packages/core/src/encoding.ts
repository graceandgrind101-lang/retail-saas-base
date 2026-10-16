/**
 * Small, dependency-free encoders. Core has no Buffer, btoa or TextEncoder (it must run
 * anywhere and carries no Node or DOM types), so the few conversions it needs are written out
 * and tested against Node's own implementations.
 */

const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    out += URL_SAFE[(chunk >> 18) & 63];
    out += URL_SAFE[(chunk >> 12) & 63];
    if (i + 1 < bytes.length) out += URL_SAFE[(chunk >> 6) & 63];
    if (i + 2 < bytes.length) out += URL_SAFE[chunk & 63];
  }
  return out;
}

const URL_SAFE_INDEX: Record<string, number> = Object.fromEntries([...URL_SAFE].map((ch, i) => [ch, i]));

/**
 * Strict base64url decoder: returns `null` for anything that is not canonical unpadded base64url
 * (wrong characters, padding, an impossible length, or non-zero spare bits), so two different
 * strings can never decode to the same bytes.
 */
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = URL_SAFE_INDEX[ch];
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) return null; // leftover bits must be zero for the encoding to be canonical
  return Uint8Array.from(bytes);
}

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** The inverse of `utf8Bytes`; `null` if the bytes are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] ?? 0;
    let length = 0;
    let code = 0;
    if (b < 0x80) {
      length = 1;
      code = b;
    } else if (b >= 0xc2 && b < 0xe0) {
      length = 2;
      code = b & 0x1f;
    } else if (b >= 0xe0 && b < 0xf0) {
      length = 3;
      code = b & 0x0f;
    } else if (b >= 0xf0 && b < 0xf5) {
      length = 4;
      code = b & 0x07;
    } else {
      return null;
    }
    if (i + length > bytes.length) return null;
    for (let k = 1; k < length; k++) {
      const next = bytes[i + k] ?? 0;
      if ((next & 0xc0) !== 0x80) return null;
      code = (code << 6) | (next & 0x3f);
    }
    if ((length === 3 && code < 0x800) || (length === 4 && (code < 0x10000 || code > 0x10ffff))) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    out += String.fromCodePoint(code);
    i += length;
  }
  return out;
}
