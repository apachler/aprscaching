# Brand source masters

Vector (Adobe Illustrator / PDF 1.5) source files for the APRScaching identity — keep these as the
canonical masters; regenerate raster/SVG web assets from them rather than editing the PNGs.

- `logo.ai` — the wordmark (white "APRScaching" with the green beacon glyph). Rasterized as
  `apps/web/public/brand/wordmark.png` (900×160).
- `beacon-blue.ai` / `beacon-green.ai` — the beacon glyph (our cache/brand icon). Rasterized as
  `apps/web/public/brand/beacon-{blue,green}.png` (1100×1300) and the favicon/PWA icon set under
  `apps/web/public/icons/`.

Palette (`colors.txt`, the original 2016 identity — already wired into `apps/web/src/brand.ts` and
the CSS tokens): blue `#2D8BAB` (chrome), green `#7BB912` (accent), grey `#4B4F51`, beige `#B57D5D`
/ `#C3934A`. Type: IBM Plex Mono (data) — already vendored under `apps/web/public/fonts/`.

> Not web-served. A future task may convert the beacon `.ai` to inline SVG for the icon system.
