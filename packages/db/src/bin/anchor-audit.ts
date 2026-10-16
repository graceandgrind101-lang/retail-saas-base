// pnpm --filter @retail/db anchor-audit        (run nightly by a scheduled job)
//   DATABASE_ADMIN_URL       owner connection (required)
//   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (all required)
// Exit code 1 means a tenant's chain or earlier anchors failed to verify: look at it today.
import postgres from "postgres";
import { z } from "zod";
import { anchorAllTenants } from "../jobs/anchor";
import { R2AnchorStore } from "../jobs/r2-store";

const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().min(1, "is empty").startsWith("postgres", "must be a postgres:// URL"),
    R2_ACCOUNT_ID: z.string().min(1, "is empty"),
    R2_BUCKET: z.string().min(1, "is empty"),
    R2_ACCESS_KEY_ID: z.string().min(1, "is empty"),
    R2_SECRET_ACCESS_KEY: z.string().min(1, "is empty"),
  })
  .safeParse(process.env);

if (!env.success) {
  // Names and reasons only, never values.
  for (const issue of env.error.issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

const sql = postgres(env.data.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
try {
  const store = new R2AnchorStore({
    accountId: env.data.R2_ACCOUNT_ID,
    bucket: env.data.R2_BUCKET,
    accessKeyId: env.data.R2_ACCESS_KEY_ID,
    secretAccessKey: env.data.R2_SECRET_ACCESS_KEY,
  });
  const report = await anchorAllTenants(sql, store);
  console.log(`anchored ${report.anchored.length}, unchanged ${report.unchanged}, failures ${report.failures.length}`);
  for (const failure of report.failures) console.error(`FAILED ${failure.tenantId}: ${failure.reason}`);
  if (report.failures.length > 0) process.exitCode = 1;
} finally {
  await sql.end();
}
