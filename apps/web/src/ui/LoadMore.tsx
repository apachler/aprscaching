/**
 * LoadMore — the cacher-surface pagination control (docs/11 / ui-ux.md). An explicit, accessible
 * button (not infinite scroll: that fights the map for the main thread and has no end for assistive
 * tech). Renders nothing when there is no next page, so a list cleanly bottoms out.
 */
export function LoadMore(props: { hasMore: boolean; loading: boolean; onClick: () => void; label?: string }) {
  if (!props.hasMore) return null;
  return (
    <div className="loadmore">
      <button className="link" onClick={props.onClick} disabled={props.loading} aria-busy={props.loading}>
        {props.loading ? "Loading…" : (props.label ?? "Load more")}
      </button>
    </div>
  );
}
