/** True when the moment is still ahead of us (a lock that has not ended). Kept out of the pages so they stay pure. */
export function stillAhead(moment: Date | null): boolean {
  return moment !== null && moment.getTime() > Date.now();
}
