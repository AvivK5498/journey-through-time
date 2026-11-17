// Tiny 5x7 dot-matrix font (own design, HD44780-style proportions) used by the head-unit
// LCD and, rendered as rounded strokes, by the printed dial/drum/button lettering.
//
// Storage: GLYPH_CHARS lists the characters; GLYPH_DATA holds 7 base-32 digits per glyph,
// one per row (top to bottom), each a 5-bit row mask with bit 4 = leftmost column.
// '>' is the play triangle and '|' the pause bars; '·' is a middle dot.
//
//   glyphIndex(charCode) -> glyph number (or -1)
//   glyphRow(g, row)     -> 5-bit row mask
//   glyphLeft(g), glyphWidth(g): trimmed columns for proportional text (digits stay 5 wide)
// Everything is decoded once at load; lookups allocate nothing.

export const GLYPH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz.,:-/!?()'+·>|";
const GLYPH_DATA =
  'ehhvhhhuhhuhhuehggghesihhhisvgguggvvggugggehgnhhfhhhvhhhe44444e72222ichikokihggggggvhrllhhhhhpljhhehhhhheuhhugggehhhliduhhukihfgge11uv444444hhhhhhehhhhha4hhhlllahha4ahhhha4444v1248gv' +
  'ehhhhhe4c4444eeh1248vv2421he26aiv22vgu11he68guhhev124888ehhehheehhf12c' +
  '00e1fhfggmphhu00egghe11djhhf00ehvge698s8880fhhf1eggmphhh40c444e20622icggikokic44444e00qllll00mphhh00ehhhe00uhugg00djf1100mpggg00ege1u88s889600hhhjd00hhha400hhlla00ha4ah00hhf1e00v248v' +
  '00000cc0000c480cc0cc0000v00001248g04444404eh12404248884284222484480000044v440000cc00gosusogrrrrrrr';

export const GLYPH_COUNT = GLYPH_CHARS.length;
export const SPACE_WIDTH = 3;

const rows = new Uint8Array(GLYPH_COUNT * 7);
const left = new Uint8Array(GLYPH_COUNT);
const width = new Uint8Array(GLYPH_COUNT);
const lookup = new Int16Array(256).fill(-1);

for (let g = 0; g < GLYPH_COUNT; g++) {
  let used = 0;
  for (let r = 0; r < 7; r++) {
    const v = parseInt(GLYPH_DATA[g * 7 + r], 32);
    rows[g * 7 + r] = v;
    used |= v;
  }
  const c = GLYPH_CHARS.charCodeAt(g);
  lookup[c & 255] = g;
  const digit = c >= 48 && c <= 57;
  let l = 0, rgt = 4;
  if (!digit && used) {
    while (!(used & (16 >> l))) l++;
    while (!(used & (16 >> rgt))) rgt--;
  }
  left[g] = l;
  width[g] = digit || !used ? 5 : rgt - l + 1;
}

export function glyphIndex(code) { return code < 256 ? lookup[code] : -1; }
export function glyphRow(g, r) { return rows[g * 7 + r]; }
export function glyphLeft(g) { return left[g]; }
export function glyphWidth(g) { return width[g]; }

// Small 3x5 caps font for LCD status labels: 5 octal digits per glyph (rows top to bottom,
// bit 2 = leftmost column). Order: SMALL_CHARS.
const SMALL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:';
const SMALL_DATA =
  '25755656563444365556746477464434553557557222711152556554444757755577752555265644255636565534216' +
  '7222255557555525577555255552227124775557262276124761216557117461634757712227575775716' + '04040';
const smallRows = new Uint8Array(SMALL_CHARS.length * 5);
for (let k = 0; k < smallRows.length; k++) smallRows[k] = SMALL_DATA.charCodeAt(k) - 48;

// Draws `str` (load time / rare updates only) in the 3x5 font at (x, y); returns the end x.
export function drawSmall(buf, stride, x, y, str, v) {
  for (let i = 0; i < str.length; i++) {
    const g = SMALL_CHARS.indexOf(str[i]);
    if (g >= 0) {
      for (let r = 0; r < 5; r++) {
        const m = smallRows[g * 5 + r];
        for (let c = 0; c < 3; c++) if (m & (4 >> c)) buf[(y + r) * stride + x + c] = v;
      }
    }
    x += str[i] === ':' ? 2 : 4;
  }
  return x - 1;
}
export function smallWidth(str) { let w = 0; for (let i = 0; i < str.length; i++) w += str[i] === ':' ? 2 : 4; return w - 1; }

// Converts a string to glyph codes (load time only): -1 = space.
export function toGlyphs(str) {
  const out = new Int16Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i] = c === 32 ? -1 : glyphIndex(c);
  }
  return out;
}

// Width in dots of a glyph run with 1-dot spacing (proportional).
export function runWidth(codes, n = codes.length) {
  let w = 0;
  for (let i = 0; i < n; i++) w += (codes[i] < 0 ? SPACE_WIDTH : glyphWidth(codes[i])) + (i < n - 1 ? 1 : 0);
  return w;
}

// Draws a glyph run into an 8-bit dot buffer (row-major, `stride` bytes per row) at
// (x, y) with value v; clips to [x0, x1). Returns the x after the run. No allocation.
export function drawRun(buf, stride, x, y, codes, n, v, x0 = 0, x1 = stride) {
  for (let i = 0; i < n; i++) {
    const g = codes[i];
    if (g < 0) { x += SPACE_WIDTH + 1; continue; }
    x = drawGlyph(buf, stride, x, y, g, v, x0, x1) + 1;
  }
  return x - 1;
}

export function drawGlyph(buf, stride, x, y, g, v, x0 = 0, x1 = stride) {
  const l = left[g], w = width[g];
  for (let r = 0; r < 7; r++) {
    const m = rows[g * 7 + r];
    for (let c = 0; c < w; c++) {
      const px = x + c;
      if (px < x0 || px >= x1) continue;
      if (m & (16 >> (l + c))) buf[(y + r) * stride + px] = v;
    }
  }
  return x + w;
}
