/**
 * How long the till may sit untouched before it locks itself. In order: the POS_IDLE_LOCK_SECONDS
 * variable (a deployment override, used by the browser tests), the shop's setting
 * `security.pos_idle_lock_seconds`, then 3 minutes. 0 turns it off. Anything that is not a whole
 * number of seconds up to a day is ignored rather than guessed at.
 */
export const DEFAULT_POS_IDLE_SECONDS = 180;
const MAX_SECONDS = 24 * 3600;

const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_SECONDS;

export function posIdleSeconds(env: Readonly<Record<string, string | undefined>>, setting?: unknown): number {
  const raw = env.POS_IDLE_LOCK_SECONDS;
  if (raw !== undefined && /^\d+$/.test(raw) && valid(Number(raw))) return Number(raw);
  return valid(setting) ? setting : DEFAULT_POS_IDLE_SECONDS;
}
