// pnpm --filter @retail/db check:db-security   (needs DATABASE_ADMIN_URL; run after migrations)
import postgres from "postgres";
import { checkDatabaseSecurity, formatViolations } from "../ci/security-check";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL: is missing");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const violations = await checkDatabaseSecurity(sql);
  if (violations.length > 0) {
    console.error(`Database security check FAILED (${violations.length}):\n${formatViolations(violations)}`);
    process.exitCode = 1;
  } else {
    console.log("check:db-security ok (every app table is isolated; schemas and roles locked down)");
  }
} finally {
  await sql.end();
}
