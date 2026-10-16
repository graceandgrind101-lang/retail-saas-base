import { describeActivity, isSettingKey, settingLabelPath } from "@retail/core";

/** What the sentence needs from a row of the activity list (the shape that crosses to the browser). */
export interface ActivityLine {
  seq: number;
  occurredAt: string;
  eventKey: string;
  tableName: string | null;
  actorKind: string;
  actorName: string | null;
  subjectName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Just what is needed of next-intl's translator. */
export interface Translate {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/** The readable line for an audit entry, or null for plumbing that is not worth showing. */
export function activitySentence(line: ActivityLine, t: Translate): string | null {
  const described = describeActivity({ eventKey: line.eventKey, tableName: line.tableName, before: line.before, after: line.after });
  if (described.hidden) return null;
  const { ruleKey, status, method } = described.params;
  const subject = line.subjectName ?? "";
  const setting = line.subjectName && isSettingKey(line.subjectName) ? t(settingLabelPath(line.subjectName)) : subject;
  const rule = ruleKey && t.has(`alerts.rule.${ruleKey}`) ? t(`alerts.rule.${ruleKey}`) : (ruleKey ?? "");
  return t(`activity.event.${described.kind}`, {
    name: subject,
    setting,
    rule,
    status: status && t.has(`alerts.status.${status}`) ? t(`alerts.status.${status}`) : "",
    method: method && t.has(`activity.method.${method}`) ? t(`activity.method.${method}`) : "",
  });
}
