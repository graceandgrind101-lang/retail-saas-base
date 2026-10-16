import { getTranslations } from "next-intl/server";

export default async function PosTodayPage() {
  const t = await getTranslations("pos");
  return (
    <div className="ui-stack">
      <h1>{t("tabs.today")}</h1>
      <p>{t("placeholder")}</p>
    </div>
  );
}
