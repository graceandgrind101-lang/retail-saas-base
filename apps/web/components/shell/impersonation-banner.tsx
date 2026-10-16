/**
 * Shown above everything when a member of OUR support team is acting inside a shop (the master key,
 * PLAN.md §5). The console that starts such a session does not exist yet, so nothing sets `shop` today;
 * the banner is here so the shell is ready and the wording is translated.
 */
export function ImpersonationBanner({ message }: { message: string }) {
  return (
    <div className="shell-banner" role="status">
      {message}
    </div>
  );
}
