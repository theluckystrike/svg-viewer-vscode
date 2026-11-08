# Export PNG and copy

1. Pick the size: PNG 1x, 2x, 4x or 8x of the SVG size, or PNG width and a width in pixels.
2. Click Save PNG to pick a file name, or Copy PNG to put the image on the clipboard.

The PNG has a transparent background. Very large sizes are made smaller to stay inside the browser canvas
limit (16,384 px on a side), and the message says so.

Copy data URI copies `data:image/svg+xml;base64,...` for CSS or HTML.

The file itself is never changed: SVG Viewer has no minify or "optimize" step that rewrites your SVG.
