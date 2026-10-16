import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { loadShellContext } from "@/lib/shell/context";

export default async function PosMorePage() {
  const ctx = await loadShellContext();
  const t = await getTranslations("pos");
  const canOpenAdmin = ctx?.permissions.includes("staff:manage") ?? false;
  return (
    <div className="ui-stack">
      <h1>{t("tabs.more")}</h1>
      {canOpenAdmin ? (
        <Link className="shell-link" href="/">
          {t("openAdmin")}
        </Link>
      ) : null}
    </div>
  );
}
