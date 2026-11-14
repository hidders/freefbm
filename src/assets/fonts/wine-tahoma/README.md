# Wine Tahoma

The font FreeFBM draws diagram text in. Its widths are those of Tahoma, the
font NORMA draws its diagrams in, so text, and with it shape sizes, comes out
as wide as in NORMA.

- Source: the Wine project, `fonts/tahoma.ttf` and `fonts/tahomabd.ttf`
  (https://gitlab.winehq.org/wine/wine, mirrored at
  https://github.com/wine-mirror/wine), commit
  9f8c4ae4d35c7ff4153267aba9618c026f5f5583 (2026-11-13). The font sources
  (`tahoma.sfd`, `tahomabd.sfd`) are in the same folder there.
- Copyright (c) 2004 Larry Snyder, based on Bitstream Vera Sans, copyright (c)
  2003 Bitstream, Inc.
- Licence: GNU Lesser General Public License, version 2.1 or later (see
  `COPYING.LIB`). The files are included unchanged.

This folder is the only part of FreeFBM under the LGPL; the rest is under
FreeFBM's own licence. To leave it out, delete this folder and the import of
`wine-tahoma.css` in `src/assets/fonts/diagram-fonts.css`: diagrams are then
drawn in DejaVu Sans, scaled to about Tahoma's widths (`../dejavu-sans`).
