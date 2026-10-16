import { describe, expect, it } from "vitest";
import { base64urlDecode, base64url, utf8Bytes, utf8Text } from "./encoding";
import { randomInt, seededRandom } from "./testing";

describe("base64urlDecode", () => {
  it("decodes what Node encodes, for every length from 0 to 80 bytes", () => {
    for (let n = 0; n <= 80; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 53 + n * 7) & 0xff);
      const encoded = Buffer.from(bytes).toString("base64url");
      expect(base64urlDecode(encoded)).toEqual(bytes);
      expect(base64urlDecode(base64url(bytes))).toEqual(bytes);
    }
  });

  it.each([
    ["a plus sign", "ab+d"],
    ["a slash", "ab/d"],
    ["padding", "abcd=="],
    ["a space", "ab cd"],
    ["a newline", "abcd\n"],
    ["a non-ASCII letter", "abcé"],
    ["an impossible length (1 mod 4)", "abcde"],
    ["a single character", "a"],
    // zero spare bits, so ONLY the length rule stops it decoding to the same bytes as "abcd"
    ["an extra 'A' that would decode to the same bytes as without it", "abcdA"],
    ["a lone 'A'", "A"],
  ])("rejects %s", (_label, text) => {
    expect(base64urlDecode(text)).toBeNull();
  });

  it("rejects a NON-CANONICAL encoding, so two strings can never mean the same bytes", () => {
    expect(base64urlDecode("AA")).toEqual(Uint8Array.of(0));
    expect(base64urlDecode("AB")).toBeNull(); // same byte, but with non-zero spare bits
    expect(base64urlDecode("AAB")).toBeNull();
    expect(base64urlDecode("AAA")).toEqual(Uint8Array.of(0, 0));
  });

  it("round-trips random bytes", () => {
    const next = seededRandom(7);
    for (let i = 0; i < 500; i++) {
      const bytes = Uint8Array.from({ length: randomInt(next, 0, 70) }, () => randomInt(next, 0, 255));
      expect(base64urlDecode(base64url(bytes))).toEqual(bytes);
    }
  });

  it("decodes the empty string to no bytes", () => {
    expect(base64urlDecode("")).toEqual(new Uint8Array(0));
  });
});

describe("utf8Bytes / utf8Text", () => {
  it.each(["", "plain ascii", "ሰላም ዓለም", "ብር 12,450", "naïve café", "emoji 😀 and 𝄞", "\u0000\u007f\u0080߿ࠀ￿"])("matches Node for %j", (text) => {
    expect(utf8Bytes(text)).toEqual(Uint8Array.from(Buffer.from(text, "utf8")));
    expect(utf8Text(utf8Bytes(text))).toBe(text);
  });

  it("round-trips random text across every range", () => {
    const next = seededRandom(99);
    const ranges: [number, number][] = [[0, 0x7f], [0x80, 0x7ff], [0x800, 0xd7ff], [0xe000, 0xffff], [0x10000, 0x10ffff]];
    for (let i = 0; i < 400; i++) {
      let text = "";
      for (let k = 0, n = randomInt(next, 0, 20); k < n; k++) {
        const [lo, hi] = ranges[randomInt(next, 0, ranges.length - 1)] ?? [0, 0x7f];
        text += String.fromCodePoint(randomInt(next, lo, hi));
      }
      expect(utf8Bytes(text)).toEqual(Uint8Array.from(Buffer.from(text, "utf8")));
      expect(utf8Text(utf8Bytes(text))).toBe(text);
    }
  });

  it.each([
    ["a lone continuation byte", [0x80]],
    ["an invalid lead byte", [0xff]],
    ["an overlong encoding of NUL", [0xc0, 0x80]],
    ["an overlong 3-byte encoding", [0xe0, 0x80, 0x80]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a truncated sequence", [0xe2, 0x82]],
    ["a bad continuation byte", [0xe2, 0x28, 0xa1]],
    ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
    ["a 5-byte lead", [0xf8, 0x88, 0x80, 0x80, 0x80]],
  ])("rejects %s", (_label, bytes) => {
    expect(utf8Text(Uint8Array.from(bytes))).toBeNull();
  });
});
