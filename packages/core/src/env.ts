import { z } from "zod";
import { devSignInProblem } from "./dev-sign-in";

/**
 * The one schema for every environment variable (Phase A task A2).
 *
 * Rules:
 *  - There are NO fallbacks and NO dev defaults. A missing or weak value stops the app at
 *    boot. (The single-tenant reference app signs sessions with the service-role key, or a
 *    hardcoded dev string if that is missing. Never again.)
 *  - Every secret is separate. Re-using one value for two purposes defeats the purpose of
 *    having two, so equal secrets are rejected.
 *  - Errors name the variable and the problem, never the value.
 *
 * `parseServerEnv` takes the environment as an argument so it stays pure and testable;
 * apps pass `process.env`.
 */

const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARS = 10;

const text = () =>
  z.string({ error: (issue) => (issue.input === undefined ? "is missing" : "must be a string") });

/** A random secret: >= 32 chars, no stray whitespace, not obviously low-entropy. */
const secret = () =>
  text()
    .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters (generate with: pnpm secrets:generate)`)
    .refine((v) => v === v.trim(), "has leading or trailing whitespace")
    .refine((v) => new Set(v).size >= MIN_DISTINCT_CHARS, "looks low-entropy (too few distinct characters)");

const postgresUrl = () =>
  text()
    .min(1, "is empty")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://");

const httpUrl = () =>
  z.url({
    protocol: /^https?$/,
    error: (issue) => (issue.input === undefined ? "is missing" : "must be an http(s) URL"),
  });

/** Values that are safe to ship to the browser. Inlined at build time by Next (NEXT_PUBLIC_). */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrl(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: text().min(20, "looks too short to be a Supabase anon key"),
  /**
   * Where this app is served, e.g. https://app.example.com (no path). Requests that change
   * anything must come from this origin, and the session cookie is marked Secure when it is https.
   */
  NEXT_PUBLIC_APP_URL: httpUrl(),
});

/** Names of every variable holding a secret value. Each one must differ from all others. */
export const SECRET_NAMES = [
  "SESSION_SECRET",
  "PIN_PEPPER",
  "DEVICE_TOKEN_PEPPER",
  "REFERENCE_PEPPER",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
] as const;

export const serverEnvSchema = publicEnvSchema
  .extend({
    DATABASE_URL: postgresUrl(),
    SUPABASE_SERVICE_ROLE_KEY: text().min(20, "looks too short to be a Supabase service-role key"),
    /** Signs staff session cookies. */
    SESSION_SECRET: secret(),
    /** Keyed hash for PINs (DATA_MODEL M9). */
    PIN_PEPPER: secret(),
    /** Keyed hash for device tokens. */
    DEVICE_TOKEN_PEPPER: secret(),
    /** Keyed hash for payment references in the cross-shop registry (Phase C). */
    REFERENCE_PEPPER: secret(),
    /**
     * Verifies login tokens signed with the project's shared secret (HS256: local Supabase and
     * older cloud projects). Leave EMPTY for projects that sign with asymmetric keys: the public
     * keys are then fetched from the project's JWKS address. An empty value counts as unset.
     */
    SUPABASE_JWT_SECRET: z.preprocess((value) => (value === "" ? undefined : value), secret().optional()),
  })
  .superRefine((env, ctx) => {
    SECRET_NAMES.forEach((name, i) => {
      for (const earlier of SECRET_NAMES.slice(0, i)) {
        // An optional secret that is not set is not "equal" to another one that is not set.
        if (env[name] !== undefined && env[name] === env[earlier]) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `must differ from ${earlier} (every secret has its own value)`,
          });
        }
      }
    });
  });

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Thrown when the environment is not usable. `problems` lists "NAME: reason" lines, never values. */
export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid environment, refusing to start:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `See apps/web/.env.example. Generate secrets with: pnpm secrets:generate`,
    );
    this.name = "EnvError";
    this.problems = problems;
  }
}

function toProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join(".") : "(environment)";
    return `${name}: ${issue.message}`;
  });
}

export function parseServerEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  const problems = result.success ? [] : toProblems(result.error);
  const danger = devSignInProblem(source);
  if (danger) problems.push(danger);
  if (!result.success || problems.length > 0) throw new EnvError(problems);
  return result.data;
}

export function parsePublicEnv(source: Readonly<Record<string, string | undefined>>): PublicEnv {
  const result = publicEnvSchema.safeParse(source);
  if (!result.success) throw new EnvError(toProblems(result.error));
  return result.data;
}
