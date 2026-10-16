import { createConfig } from "@retail/config/eslint";

// packages/db defines db.admin, so it may import it (PLAN.md §2.4).
export default createConfig({ allowDbAdminEverywhere: true });
