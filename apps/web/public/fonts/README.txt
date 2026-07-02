Fonts bundled with the APRScaching web app
==========================================

Fredoka-500.woff2 / Fredoka-600.woff2 / Fredoka-700.woff2
  Family : Fredoka (the rounded sans of the APRScaching wordmark)
  Author : Milena Brandao, Hafontia
  License: SIL Open Font License 1.1 (OFL-1.1)
  Source : https://fonts.google.com/specimen/Fredoka  ·  https://github.com/hafontia-zz/Fredoka
  Subset : latin (via @fontsource/fredoka), weights 500/600/700.

The OFL permits bundling and self-hosting; see the upstream repository for the
full license text. Used here for headings to match the logo.

IBMPlexMono-400.woff2 / IBMPlexMono-500.woff2 / IBMPlexMono-600.woff2
  Family : IBM Plex Mono (technical/data type — callsigns, coordinates, ids)
  Author : Mike Abbink / Bold Monday, for IBM
  License: SIL Open Font License 1.1 (OFL-1.1)
  Source : https://fonts.google.com/specimen/IBM+Plex+Mono  ·  https://github.com/IBM/plex
  Subset : latin, weights 400/500/600.

Used for the "operator" data surfaces (callsigns, grids, coordinates, cache ids)
alongside Fredoka, per the M8 operator-UI design pass. OFL permits self-hosting.

WebPlus_IBM_VGA_8x16.woff
  Family : PxPlus IBM VGA8 (declared @font-face name; file = "WebPlus IBM VGA 8x16")
  Author : VileR — from "The Ultimate Oldschool PC Font Pack" v2.2
  License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
  Source : https://int10h.org/oldschool-pc-fonts/
  Use    : the authentic CP437/VGA face (box-drawing + block glyphs) for the Cogmind theme only —
           referenced solely by the [data-theme="cogmind"] --font-mono stack, so it is never fetched
           on the Modern / field path (docs/24 §1a·4). CC BY-SA 4.0 requires this attribution.
