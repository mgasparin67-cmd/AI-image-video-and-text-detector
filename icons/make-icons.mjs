// Writes one SVG per icon size. The 128 px store icon keeps 16 px of transparent padding, as
// Chrome's guidelines ask; toolbar sizes fill the canvas so the mark stays readable at 16 px.
import { writeFileSync } from 'node:fs';
const INK = '#12161d', SIGNAL = '#f0a800';
function svg(size, pad, radius) {
  const s = size - pad * 2;
  const p = (x, y) => `${pad + x * s},${pad + y * s}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs><clipPath id="c"><rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${radius}"/></clipPath></defs>
<g clip-path="url(#c)">
<rect x="${pad}" y="${pad}" width="${s}" height="${s}" fill="${INK}"/>
<polygon points="${p(0, .58)} ${p(1, .32)} ${p(1, 1)} ${p(0, 1)}" fill="${SIGNAL}"/>
</g></svg>`;
}
const specs = { 16: [0, 3.5], 32: [0, 7], 48: [2, 10], 128: [16, 22] };
for (const [size, [pad, r]] of Object.entries(specs)) writeFileSync(`icon${size}.svg`, svg(+size, pad, r));
