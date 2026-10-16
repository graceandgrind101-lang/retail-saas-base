// pnpm db:verify-audit        (no storage needed: checks every shop's audit chain inside the database)
//   DATABASE_ADMIN_URL       owner connection (required)
// Exit code 1 means a chain is broken: look at it today.
import postgres from "postgres";

const url = process.env.DATABASE_ADMIN_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_ADMIN_URL: is missing or not a postgres:// URL");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const tenants = await sql<{ id: string; slug: string }[]>`select id, slug from platform.tenants order by slug`;
  let bad = 0;
  let entries = 0;
  for (const tenant of tenants) {
    const [chain] = await sql<{ ok: boolean; checked: string; bad_seq: string | null; reason: string | null }[]>`
      select ok, checked::text, bad_seq::text, reason from audit.verify_chain(${tenant.id}::uuid)`;
    if (chain?.ok) entries += Number(chain.checked);
    else {
      bad += 1;
      console.error(`BROKEN ${tenant.slug}: seq ${chain?.bad_seq}: ${chain?.reason}`);
    }
  }
  console.log(`audit chains: ${tenants.length - bad} of ${tenants.length} shops verified (${entries} entries)`);
  if (bad > 0) process.exitCode = 1;
} finally {
  await sql.end();
}
