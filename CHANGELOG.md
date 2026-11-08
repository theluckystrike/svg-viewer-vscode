# Changelog

## 0.1.0

- First release. Side preview with live update while you type, and an SVG Viewer editor for "Reopen Editor With..." and `.svgz` files.
- Wheel zoom at the pointer, drag to pan at any zoom, Fit and 1:1. The view is kept when the file changes and after a window reload.
- Checkerboard, white, black, theme or custom background, kept per workspace.
- viewBox outline with the area outside it dimmed. Width, height, viewBox, file size, element and symbol count, and the pointer position in SVG units.
- Follows files that are rewritten, or deleted and written again, by other tools.
- PNG export at 1x, 2x, 4x, 8x or a set width, to a file or the clipboard. Copy as a data URI.
- Light or dark preview for SVGs with `prefers-color-scheme` styles.
- Symbol grid for sprite sheets; a click copies the `<use>` line.
- Draws the SVG as an image: scripts never run and nothing is fetched. Large files ask before they draw.
