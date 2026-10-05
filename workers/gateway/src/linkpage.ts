// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * linkpage.ts — the pages a browser sees when it opens a link from a mail: the confirm step of a sign-in link,
 * an address confirmation, a data link or an operator link, and every outcome that does not end in the app.
 *
 * The gateway serves these pages itself, so they carry their own small stylesheet: the app's colour tokens for
 * Dark (the default) and Light, chosen by the Appearance setting the app keeps in this origin's storage, or by
 * the system preference when there is none. Phosphor shows as Dark here. Every value interpolated into a page is
 * escaped; the pages load nothing but the wordmark.
 */
import { escapeHtml } from "./util/html.js";

/** One action at the foot of a page: a form POST (the confirm step) or a link back into the app. */
type PageAction =
  { kind: "form"; label: string; fields: Record<string, string> } | { kind: "link"; label: string; href: string };

interface LinkPage {
  title: string;
  /** Paragraphs of plain text; each is escaped. */
  body: string[];
  action?: PageAction;
  /** A quiet line under the action. */
  note?: string;
  /** A refusal reads as an alert to a screen reader. */
  alert?: boolean;
}

/**
 * The tokens, as in apps/web/src/styles/tokens.css: Dark on `:root`, Light under the system preference unless
 * the page names a theme, and again under `[data-theme="light"]`.
 */
const STYLE = `
:root{color-scheme:dark;--page:oklch(0.17 0.012 220);--surface:oklch(0.22 0.012 220);--ink:oklch(0.94 0.006 220);
--muted:oklch(0.71 0.018 220);--line:oklch(0.33 0.016 222);--bar:oklch(0.22 0.018 228);--accent:oklch(0.73 0.18 128);
--accent-ink:oklch(0.2 0.012 220);--link:oklch(0.74 0.078 228);--bad:oklch(0.74 0.15 27);--focus:var(--accent)}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;--page:oklch(0.97 0.003 220);
--surface:oklch(1 0 0);--ink:oklch(0.33 0.006 220);--muted:oklch(0.52 0.009 220);--line:oklch(0.92 0.004 220);
--bar:oklch(0.5 0.085 232);--link:oklch(0.5 0.072 230);--bad:oklch(0.5 0.17 27);--focus:oklch(0.48 0.15 135)}}
:root[data-theme="light"]{color-scheme:light;--page:oklch(0.97 0.003 220);--surface:oklch(1 0 0);
--ink:oklch(0.33 0.006 220);--muted:oklch(0.52 0.009 220);--line:oklch(0.92 0.004 220);--bar:oklch(0.5 0.085 232);
--link:oklch(0.5 0.072 230);--bad:oklch(0.5 0.17 27);--focus:oklch(0.48 0.15 135)}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--bar);padding:12px 16px;padding-top:max(12px,env(safe-area-inset-top))}
header img{display:block;height:28px;width:auto}
main{max-width:30rem;margin:clamp(16px,6vh,48px) auto;padding:0 16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px}
h1{font-size:20px;line-height:1.3;margin:0 0 8px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:13px}
a{color:var(--link)}
.primary{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;border:0;
border-radius:10px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.primary:hover{background:color-mix(in oklab,var(--accent) 88%,white)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
form,.actions{margin:16px 0 12px}
.alert h1{color:var(--bad)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;

/** The Appearance setting before the first paint: the same rule as the app's head script (apps/web/index.html). */
const THEME_SCRIPT = `(function(){try{var t=(JSON.parse(localStorage.getItem("acs.locale")||"{}")||{}).theme;
if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else if(t!=="auto")document.documentElement.dataset.theme="dark";}catch(e){}})();`;

function actionHtml(a: PageAction): string {
  if (a.kind === "link")
    return `<p class=actions><a class=primary href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a></p>`;
  const fields = Object.entries(a.fields)
    .map(([k, v]) => `<input type=hidden name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<form method="post" action="/auth/email/verify">${fields}<button class=primary type=submit>${escapeHtml(a.label)}</button></form>`;
}

/**
 * The page as a response. The `same-origin` referrer policy keeps a token-bearing URL from reaching any other
 * site, while a form POST still carries this page's origin — under `no-referrer` a browser sends `Origin: null`,
 * which the confirm step's origin check refuses.
 */
export function linkPageResponse(page: LinkPage, status = 200): Response {
  const body = page.body.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  const html = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name=referrer content=same-origin><meta name=robots content=noindex>
<title>${escapeHtml(page.title)} · APRScaching</title><script>${THEME_SCRIPT}</script><style>${STYLE}</style></head>
<body><header><img src="/brand/wordmark.png" alt="APRScaching" width=158 height=28></header>
<main><div class="card${page.alert ? " alert" : ""}"${page.alert ? " role=alert" : ""}><h1>${escapeHtml(page.title)}</h1>${body}${
    page.action ? actionHtml(page.action) : ""
  }${page.note ? `<p class=muted>${escapeHtml(page.note)}</p>` : ""}</div></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
    },
  });
}

/** Does this request come from a browser navigating to a page (not a script calling the API)? */
export function wantsPage(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}
