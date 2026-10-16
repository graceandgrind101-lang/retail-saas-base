import { redirect } from "next/navigation";
import { settingValue } from "@retail/core";
import { PosShell } from "@/components/shell/pos-shell";
import { loadShellContext } from "@/lib/shell/context";
import { posIdleSeconds } from "@/lib/shell/idle";
import { shellProps } from "@/lib/shell/props";

// The till: only for someone who signed in with a PIN on a connected device.
export default async function PosLayout({ children }: { children: React.ReactNode }) {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.device) redirect("/");
  const props = await shellProps(ctx);
  return (
    <PosShell deviceName={ctx.device.name} staffName={props.staffName} alerts={props.alerts} idleSeconds={posIdleSeconds(process.env, settingValue(ctx.settings, "security.pos_idle_lock_seconds"))} locale={props.locale} calendar={props.calendar}>
      {children}
    </PosShell>
  );
}
