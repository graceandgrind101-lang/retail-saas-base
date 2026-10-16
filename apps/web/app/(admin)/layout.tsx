import { redirect } from "next/navigation";
import { buildAdminNav } from "@retail/core";
import { FormatProvider } from "@/components/format-context";
import { AdminShell } from "@/components/shell/admin-shell";
import { loadShellContext } from "@/lib/shell/context";
import { shellProps } from "@/lib/shell/props";

// Everything in the admin app needs a signed-in person; the menu is narrowed to what they may see.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  const nav = buildAdminNav({ enabledModules: ctx.modules, permissions: new Set(ctx.permissions) });
  const props = await shellProps(ctx);
  return (
    <AdminShell nav={nav} {...props}>
      <FormatProvider calendar={props.calendar} timeZone={ctx.tenant.timezone}>
        {children}
      </FormatProvider>
    </AdminShell>
  );
}
