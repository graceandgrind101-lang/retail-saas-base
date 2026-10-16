"use client";

import { useTranslations } from "next-intl";
import { activitySentence, type ActivityLine } from "@/lib/activity/sentence";
import { useFormat } from "./format-context";

/**
 * A timeline of what happened, newest first: the sentence, who did it, and when. Used on the
 * Activity screen and on a person's or device's own page (docs/SCREENS.md: an activity timeline on
 * every record). Entries that are plumbing are left out.
 */
export function RecordTimeline({ lines }: { lines: ActivityLine[] }) {
  const t = useTranslations();
  const format = useFormat();
  const shown = lines.flatMap((line) => {
    const sentence = activitySentence(line, t as unknown as Parameters<typeof activitySentence>[1]);
    return sentence === null ? [] : [{ line, sentence }];
  });
  if (shown.length === 0) return <p>{t("activity.empty")}</p>;
  return (
    <ol className="timeline">
      {shown.map(({ line, sentence }) => (
        <li key={line.seq} className="timeline-item">
          <span className="timeline-sentence">{sentence}</span>
          <small>
            {line.actorName ? t("activity.bySomeone", { actor: line.actorName }) : line.actorKind === "system" ? t("activity.bySystem") : ""} · {format.dateTime(line.occurredAt)}
          </small>
        </li>
      ))}
    </ol>
  );
}
