import { describe, expect, it } from "vitest";
import { EnvError, SECRET_NAMES, parsePublicEnv, parseServerEnv } from "./env";

// Test-only values. Each secret is unique and has plenty of distinct characters.
const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-0123456789-abcdefghij",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789-ABCDEFGHIJ",
  SESSION_SECRET: "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0",
  PIN_PEPPER: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b",
  DEVICE_TOKEN_PEPPER: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j",
  REFERENCE_PEPPER: "Lk9jHg6fDs3aPo0iUy7tRe4wQz1xCv8n",
} as const;

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseServerEnv(env);
  } catch (e) {
    if (e instanceof EnvError) return e.problems;
    throw e;
  }
  return [];
}

describe("parseServerEnv (boot-time environment check)", () => {
  it("accepts a complete, valid environment and ignores unrelated variables", () => {
    const env = parseServerEnv({ ...valid, PATH: "/usr/bin", HOME: "/home/x" });
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(Object.keys(env)).not.toContain("PATH");
  });

  it.each(Object.keys(valid))("refuses to boot when %s is missing, and names it", (name) => {
    const env: Record<string, string | undefined> = { ...valid };
    delete env[name];
    const problems = problemsOf(env);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.startsWith(`${name}:`))).toBe(true);
  });

  it("treats an empty value as a problem", () => {
    expect(problemsOf({ ...valid, SESSION_SECRET: "" }).some((p) => p.startsWith("SESSION_SECRET:"))).toBe(true);
    expect(problemsOf({ ...valid, DATABASE_URL: "" }).some((p) => p.startsWith("DATABASE_URL:"))).toBe(true);
  });

  it("reports every problem at once, not just the first", () => {
    const problems = problemsOf({ ...valid, SESSION_SECRET: undefined, PIN_PEPPER: "short", DATABASE_URL: "http://x" });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(problemsOf({ ...valid, PIN_PEPPER: "dev-only-secret" }).some((p) => p.startsWith("PIN_PEPPER:"))).toBe(true);
  });

  it("rejects a low-entropy secret even when long enough", () => {
    expect(problemsOf({ ...valid, PIN_PEPPER: "a".repeat(40) }).some((p) => p.includes("low-entropy"))).toBe(true);
    expect(problemsOf({ ...valid, PIN_PEPPER: "ab".repeat(20) }).some((p) => p.includes("low-entropy"))).toBe(true);
  });

  it("rejects a secret with leading or trailing whitespace (copy-paste newline)", () => {
    expect(problemsOf({ ...valid, SESSION_SECRET: `${valid.SESSION_SECRET}\n` }).some((p) => p.includes("whitespace"))).toBe(true);
  });

  it("rejects two secrets with the same value", () => {
    const problems = problemsOf({ ...valid, PIN_PEPPER: valid.SESSION_SECRET });
    expect(problems.some((p) => p.startsWith("PIN_PEPPER:") && p.includes("must differ from SESSION_SECRET"))).toBe(true);
  });

  it("rejects a pepper that equals the Supabase service-role key (reference-app fallback bug)", () => {
    const reused = valid.SUPABASE_SERVICE_ROLE_KEY.padEnd(40, "x");
    const problems = problemsOf({ ...valid, SUPABASE_SERVICE_ROLE_KEY: reused, SESSION_SECRET: reused });
    expect(problems.some((p) => p.includes("must differ from"))).toBe(true);
  });

  it("checks every secret against every other, not just neighbours", () => {
    for (const a of SECRET_NAMES) {
      for (const b of SECRET_NAMES) {
        if (a === b) continue;
        const env = { ...valid, [a]: valid.REFERENCE_PEPPER.padEnd(40, "q"), [b]: valid.REFERENCE_PEPPER.padEnd(40, "q") };
        expect(problemsOf(env).some((p) => p.includes("must differ from"))).toBe(true);
      }
    }
  });

  it("rejects a database URL that is not postgres", () => {
    expect(problemsOf({ ...valid, DATABASE_URL: "mysql://u:p@h/db" }).some((p) => p.startsWith("DATABASE_URL:"))).toBe(true);
  });

  it("rejects a non-http Supabase URL", () => {
    expect(problemsOf({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "ftp://example.com" }).length).toBeGreaterThan(0);
    expect(problemsOf({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "not a url" }).length).toBeGreaterThan(0);
  });

  it("never puts a secret value in the error message", () => {
    const leaky = {
      ...valid,
      SESSION_SECRET: "hunter2-hunter2-hunter2-hunter2-hunter2 ", // trailing space -> invalid
      PIN_PEPPER: "tooshort-but-secret",
      DATABASE_URL: "postgresql://admin:p4ssw0rd-do-not-print@db.example.com/x ", // only used if parse fails elsewhere
    };
    let message = "";
    try {
      parseServerEnv({ ...leaky, REFERENCE_PEPPER: undefined });
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).not.toBe("");
    for (const value of ["hunter2", "tooshort-but-secret", "p4ssw0rd-do-not-print"]) {
      expect(message).not.toContain(value);
    }
  });
});

describe("the sign-in settings", () => {
  it("the app address is required and must be an http(s) URL", () => {
    const env: Record<string, string | undefined> = { ...valid };
    delete env.NEXT_PUBLIC_APP_URL;
    expect(problemsOf(env).some((p) => p.startsWith("NEXT_PUBLIC_APP_URL:"))).toBe(true);
    expect(problemsOf({ ...valid, NEXT_PUBLIC_APP_URL: "ftp://x.test" }).some((p) => p.startsWith("NEXT_PUBLIC_APP_URL:"))).toBe(true);
    expect(problemsOf({ ...valid, NEXT_PUBLIC_APP_URL: "app.example.com" }).some((p) => p.startsWith("NEXT_PUBLIC_APP_URL:"))).toBe(true);
  });

  it("the token-signing secret is optional, and an empty value counts as not set", () => {
    expect(problemsOf(valid)).toEqual([]);
    expect(problemsOf({ ...valid, SUPABASE_JWT_SECRET: "" })).toEqual([]);
    expect(parseServerEnv({ ...valid, SUPABASE_JWT_SECRET: "" }).SUPABASE_JWT_SECRET).toBeUndefined();
  });

  it("when given, it must be a strong secret of its own", () => {
    expect(problemsOf({ ...valid, SUPABASE_JWT_SECRET: "short" }).some((p) => p.startsWith("SUPABASE_JWT_SECRET:"))).toBe(true);
    expect(problemsOf({ ...valid, SUPABASE_JWT_SECRET: "a".repeat(40) }).some((p) => p.includes("low-entropy"))).toBe(true);
    expect(problemsOf({ ...valid, SUPABASE_JWT_SECRET: valid.SESSION_SECRET }).some((p) => p.includes("must differ from"))).toBe(true);
    expect(problemsOf({ ...valid, SUPABASE_JWT_SECRET: "Mn4bVc7xZl1kJh8gFd3sAp6oIu9yTr2e" })).toEqual([]);
  });

  it("two unset optional secrets are not treated as equal to each other", () => {
    // only one optional secret exists today; this guards the comparison for any future one
    expect(problemsOf({ ...valid, SUPABASE_JWT_SECRET: undefined })).toEqual([]);
  });
});

describe("parsePublicEnv", () => {
  it("needs only the NEXT_PUBLIC_ values", () => {
    const pub = parsePublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: valid.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: valid.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_APP_URL: valid.NEXT_PUBLIC_APP_URL,
    });
    expect(pub.NEXT_PUBLIC_SUPABASE_URL).toBe(valid.NEXT_PUBLIC_SUPABASE_URL);
  });

  it("throws EnvError when missing", () => {
    expect(() => parsePublicEnv({})).toThrow(EnvError);
  });
});
