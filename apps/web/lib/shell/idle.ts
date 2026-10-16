/**
 * How long the till may sit untouched before it locks itself: 3 minutes unless the shop's setting
 * (task A14) or the POS_IDLE_LOCK_SECONDS variable says otherwise. 0 turns it off. Anything that is
 * not a whole number of seconds up to a day falls back to the default rather than guessing.
 */
export const DEFAULT_POS_IDLE_SECONDS = 180;
const MAX_SECONDS = 24 * 3600;

export function posIdleSeconds(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.POS_IDLE_LOCK_SECONDS;
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_POS_IDLE_SECONDS;
  const seconds = Number(raw);
  return seconds <= MAX_SECONDS ? seconds : DEFAULT_POS_IDLE_SECONDS;
}
