import { describe, expect, it } from "vitest";
import { clearedSessionCookieHeader, isHttps, sessionCookieHeader, sessionCookieName } from "../lib/auth/cookie";

describe("session cookie attributes", () => {
  it("over plain http (local development): ordinary name, not Secure", () => {
    expect(isHttps("http://localhost:3000")).toBe(false);
    expect(sessionCookieName("http://localhost:3000")).toBe("retail_session");
    const header = sessionCookieHeader("http://localhost:3000", "abc.def", 3600);
    expect(header).toBe("retail_session=abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600");
  });

  it("over https: __Host- prefix and Secure, which the browser enforces (no Domain, path /)", () => {
    expect(isHttps("https://app.example.com")).toBe(true);
    expect(sessionCookieName("https://app.example.com")).toBe("__Host-retail_session");
    const header = sessionCookieHeader("https://app.example.com", "abc.def", 3600);
    expect(header).toBe("__Host-retail_session=abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure");
    expect(header).not.toMatch(/domain/i);
  });

  it("is always HttpOnly (a script on the page can never read a sign-in) and SameSite=Lax", () => {
    for (const url of ["http://localhost:3000", "https://app.example.com"]) {
      const header = sessionCookieHeader(url, "v", 60);
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
    }
  });

  it("rounds the lifetime down to whole seconds and never goes negative", () => {
    expect(sessionCookieHeader("http://localhost:3000", "v", 59.9)).toContain("Max-Age=59");
    expect(sessionCookieHeader("http://localhost:3000", "v", -5)).toContain("Max-Age=0");
    expect(sessionCookieHeader("http://localhost:3000", "v", 0)).toContain("Max-Age=0");
  });

  it("the clearing header expires the cookie immediately under the SAME name and path", () => {
    expect(clearedSessionCookieHeader("http://localhost:3000")).toBe(
      "retail_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
    const https = clearedSessionCookieHeader("https://app.example.com");
    expect(https.startsWith("__Host-retail_session=; Path=/;")).toBe(true);
    expect(https).toContain("Secure");
  });
});
