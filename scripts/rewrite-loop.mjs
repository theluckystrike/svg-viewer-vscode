// Rewrites an SVG every second, like a build tool or a plotting script. Every 5th time it deletes the file and
// writes it again a moment later, and every 7th time it writes the file in two halves (a torn write).
// usage: node scripts/rewrite-loop.mjs <file> <seconds>
import fs from 'node:fs';
const [file, secs = '60'] = process.argv.slice(2);
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const pic = (i) => `<svg ${NS} width="300" height="150" viewBox="0 0 300 150"><rect width="300" height="150" fill="#f4f6fb"/>`
  + `<rect x="${10 + (i * 23) % 220}" y="40" width="70" height="70" rx="8" fill="hsl(${(i * 37) % 360} 70% 50%)"/>`
  + `<text x="150" y="140" text-anchor="middle" font-size="14" font-family="sans-serif">frame ${i}</text></svg>\n`;
let i = 0;
const end = Date.now() + Number(secs) * 1000;
const tick = () => {
  i++;
  const text = pic(i);
  if (i % 5 === 0) { try { fs.unlinkSync(file); } catch {} setTimeout(() => fs.writeFileSync(file, text), 300); }
  else if (i % 7 === 0) { const h = text.length >> 1; fs.writeFileSync(file, text.slice(0, h)); setTimeout(() => fs.appendFileSync(file, text.slice(h)), 60); }
  else fs.writeFileSync(file, text);
  if (Date.now() < end) setTimeout(tick, 1000); else console.log('frames', i);
};
tick();
