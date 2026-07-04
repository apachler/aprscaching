// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * DocsPanel — the in-app manual reader. The whole `docs/` markdown tree is bundled at build time
 * (see vite-docs.ts → `virtual:docs`) and rendered client-side (docs/markdown.ts), so the platform
 * serves its own documentation with no MkDocs and no extra service. A grouped sidebar lists every
 * page; internal `*.md` links navigate within the panel; external links open in a new tab. The
 * current page lives in local state, so the whole manual is one self-contained surface.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DOC_PAGES, type DocPage } from "virtual:docs";
import { Panel, EmptyState } from "../ui/index.js";
import { renderMarkdown } from "./markdown.js";

/** Pages grouped into their sections, section order preserved from the manifest order. */
function useSections(): { section: string; pages: DocPage[] }[] {
  return useMemo(() => {
    const groups: { section: string; pages: DocPage[] }[] = [];
    for (const p of DOC_PAGES) {
      let g = groups.find((x) => x.section === p.section);
      if (!g) groups.push((g = { section: p.section, pages: [] }));
      g.pages.push(p);
    }
    return groups;
  }, []);
}

export function DocsPanel(props: { initialSlug?: string; onClose: () => void }) {
  const sections = useSections();
  const [slug, setSlug] = useState(props.initialSlug || "index");
  const [pendingAnchor, setPendingAnchor] = useState("");
  const page = DOC_PAGES.find((p) => p.slug === slug) ?? null;
  const html = useMemo(() => (page ? renderMarkdown(page.body, page.slug) : ""), [page]);
  const bodyRef = useRef<HTMLDivElement>(null);

  function scrollToAnchor(id: string) {
    const target = bodyRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function navTo(nextSlug: string, anchor = "") {
    if (nextSlug === slug) {
      if (anchor) scrollToAnchor(anchor);
      return;
    }
    setPendingAnchor(anchor);
    setSlug(nextSlug);
  }

  // Intercept clicks on rewritten internal doc links; external links behave normally.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a[data-doc]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      navTo(a.getAttribute("data-doc") || "index", a.getAttribute("data-anchor") || "");
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  });

  // On page change, jump to the pending anchor (cross-page link) or back to the top.
  useEffect(() => {
    if (pendingAnchor) {
      scrollToAnchor(pendingAnchor);
      setPendingAnchor("");
    } else {
      bodyRef.current?.scrollTo?.({ top: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on rendered page (html), not on the transient anchor
  }, [html]);

  return (
    <Panel title="Manual" side="left" wide onClose={props.onClose}>
      <div className="docs">
        <nav className="docs-nav" aria-label="Manual contents">
          {sections.map((g) => (
            <div key={g.section} className="docs-navgroup">
              <p className="docs-navhead">{g.section}</p>
              {g.pages.map((p) => (
                <button
                  key={p.slug}
                  className={p.slug === slug ? "on" : ""}
                  aria-current={p.slug === slug ? "page" : undefined}
                  onClick={() => navTo(p.slug)}
                >
                  {p.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        {page ? (
          <article
            ref={bodyRef}
            className="docs-body"
            // First-party content, bundled at build time and HTML-escaped by the renderer.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="docs-body">
            <EmptyState>Page not found — pick one from the contents on the left.</EmptyState>
          </div>
        )}
      </div>
    </Panel>
  );
}
