import { redirect } from "next/navigation";
import { SETTING_GROUPS } from "@retail/core";
import { SettingsView } from "./settings-view";
import { loadShellContext } from "@/lib/shell/context";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.permissions.includes("settings:view")) redirect("/");
  const { tab } = await searchParams;
  // only sections that have something to show (a hidden setting is not shown at all)
  const groups = SETTING_GROUPS.filter((group) => ctx.settings.some((view) => view.group === group));
  const current = groups.find((group) => group === tab) ?? groups[0] ?? "business";
  return <SettingsView views={ctx.settings} groups={[...groups]} current={current} canEdit={ctx.permissions.includes("settings:edit")} staffId={ctx.staff.staffId} />;
}
