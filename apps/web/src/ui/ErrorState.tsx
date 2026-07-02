/**
 * ErrorState — a fetch/action failed. Distinct from EmptyState (ui-ux.md §4): it says something went
 * wrong and offers a retry, so an outage/500 is never misread as "nothing here". Muted-error body text
 * with an optional Retry button; colour comes from the --bad token (never colour alone — it has text).
 */
import type { ReactNode } from "react";

export function ErrorState(props: { children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="empty">
      <p className="error">{props.children ?? "Couldn't load this — check your connection and try again."}</p>
      {props.onRetry && <div className="empty-action"><button onClick={props.onRetry}>Retry</button></div>}
    </div>
  );
}
