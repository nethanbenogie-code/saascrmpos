// LysiPOS — self-contained Code128B + QR encoders (SVG output).

/* ===================== Code128 subset B ===================== */
const C128 = [
  '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100',
  '10001100100','11001001000','11001000100','11000100100','10110011100','10011011100','10011001110','10111001100',
  '10011101100','10011100110','11001110010','11001011100','11001001110','11011100100','11001110100','11101101110',
  '11101001100','11100101100','11100100110','11101100100','11100110100','11100110010','11011011000','11011000110',
  '11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
  '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110',
  '11101110110','11010001110','11000101110','11011101000','11011100010','11011101110','11101011000','11101000110',
  '11100010110','11101101000','11101100010','11100011010','11101111010','11001000010','11110001010','10100110000',
  '10100001100','10010110000','10010000110','10000101100','10000100110','10110010000','10110000100','10011010000',
  '10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
  '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100',
  '11110010010','11011011110','11011110110','11110110110','10101111000','10100011110','10001011110','10111101000',
  '10111100010','11110101000','11110100010','10111011110','10111101110','11101011110','11110101110','11010000100',
  '11010010000','11010011100','1100011101011'
];

const escXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));

// Encode ASCII 32..126 as Code128B. Returns an SVG string.
export function code128BSvg(text, opts = {}) {
  const clean = String(text).replace(/[^\x20-\x7E]/g, '?');
  if (!clean.length) throw new Error('empty barcode');
  const codes = [104]; // start B
  for (let i = 0; i < clean.length; i++) codes.push(clean.charCodeAt(i) - 32);
  let sum = 104;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103);
  codes.push(106); // stop
  const modules = codes.map((c) => C128[c]).join('');
  const w = opts.moduleWidth || 2;
  const h = opts.height || 60;
  const showText = opts.showText !== false;
  const padH = opts.paddingH != null ? opts.paddingH : 10;
  const padV = opts.paddingV != null ? opts.paddingV : 8;
  const textH = showText ? 14 : 0;
  const totalW = modules.length * w;
  const svgW = totalW + padH * 2;
  const svgH = h + padV * 2 + textH;
  let bars = '', x = padH;
  for (const m of modules) {
    if (m === '1') bars += `<rect x="${x}" y="${padV}" width="${w}" height="${h}" fill="#000"/>`;
    x += w;
  }
  const label = showText
    ? `<text x="${svgW / 2}" y="${padV + h + 12}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" fill="#000">${escXml(clean)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}"><rect width="100%" height="100%" fill="#fff"/>${bars}${label}</svg>`;
}

/* ===================== QR code (byte mode, ECC M, versions 1..10) ===================== */

// GF(256) log/exp tables
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function rsGen(deg) {
  let poly = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      if (poly[j] !== 0) next[j] ^= GF_EXP[(GF_LOG[poly[j]] + i) % 255];
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, deg) {
  const gen = rsGen(deg);
  const res = new Uint8Array(deg);
  for (const b of data) {
    const factor = b ^ res[0];
    for (let i = 0; i < deg - 1; i++) res[i] = res[i + 1];
    res[deg - 1] = 0;
    if (factor !== 0) {
      const fLog = GF_LOG[factor];
      for (let i = 0; i < gen.length - 1; i++) {
        const g = gen[i + 1];
        if (g !== 0) res[i] ^= GF_EXP[(GF_LOG[g] + fLog) % 255];
      }
    }
  }
  return res;
}

// ECC Level M: [ecPerBlock, [group1Blocks, group1DataPerBlock], (optional [group2Blocks, group2DataPerBlock])]
const M_BLOCKS = [null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]]
];

function totalDataCodewords(version) {
  const info = M_BLOCKS[version];
  let total = info[1][0] * info[1][1];
  if (info[2]) total += info[2][0] * info[2][1];
  return total;
}
function charCountBits(version) { return version < 10 ? 8 : 16; }

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const cap = totalDataCodewords(v) * 8 - 4 - charCountBits(v);
    if (byteLen * 8 <= cap) return v;
  }
  throw new Error('Data too long for QR (max ~213 bytes / version 10)');
}

function encodeToCodewords(bytes, version) {
  const cap = totalDataCodewords(version);
  const bits = [];
  bits.push(0, 1, 0, 0); // byte mode
  const ccb = charCountBits(version);
  for (let i = ccb - 1; i >= 0; i--) bits.push((bytes.length >> i) & 1);
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  const term = Math.min(4, cap * 8 - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  const padA = 0xEC, padB = 0x11;
  while (data.length < cap) { data.push(padA); if (data.length < cap) data.push(padB); }
  return new Uint8Array(data);
}

function interleave(dataCw, version) {
  const info = M_BLOCKS[version];
  const ecLen = info[0];
  const groups = [info[1]];
  if (info[2]) groups.push(info[2]);
  const dataBlocks = [], ecBlocks = [];
  let idx = 0;
  for (const [numBlocks, dataPerBlock] of groups) {
    for (let i = 0; i < numBlocks; i++) {
      const block = dataCw.slice(idx, idx + dataPerBlock);
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
      idx += dataPerBlock;
    }
  }
  const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
  const out = [];
  for (let i = 0; i < maxDataLen; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return new Uint8Array(out);
}

const ALIGN = { 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34], 7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50] };

function makeMatrix(version) {
  const size = 21 + (version - 1) * 4;
  const mat = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const placeFinder = (rr, cc) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = rr + dr, c = cc + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      let v;
      if (dr === -1 || dr === 7 || dc === -1 || dc === 7) v = 0;
      else if (dr === 0 || dr === 6 || dc === 0 || dc === 6) v = 1;
      else if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) v = 1;
      else v = 0;
      mat[r][c] = v;
      reserved[r][c] = 1;
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Format info reservation (values filled per mask later)
  for (let i = 0; i < 9; i++) { if (i !== 6) { reserved[8][i] = 1; reserved[i][8] = 1; } }
  reserved[8][8] = 1;
  for (let i = 0; i < 8; i++) reserved[size - 1 - i][8] = 1;
  for (let i = 0; i < 8; i++) reserved[8][size - 1 - i] = 1;
  // Always-dark module
  mat[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    mat[6][i] = i % 2 === 0 ? 1 : 0;
    mat[i][6] = i % 2 === 0 ? 1 : 0;
    reserved[6][i] = 1;
    reserved[i][6] = 1;
  }

  // Alignment patterns
  if (version >= 2) {
    const coords = ALIGN[version];
    for (const r of coords) for (const c of coords) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc;
        let v;
        if (Math.abs(dr) === 2 || Math.abs(dc) === 2) v = 1;
        else if (dr === 0 && dc === 0) v = 1;
        else v = 0;
        mat[rr][cc] = v;
        reserved[rr][cc] = 1;
      }
    }
  }
  return { mat, reserved, size };
}

function placeData(mat, reserved, size, cw) {
  let bitIdx = 0;
  const totalBits = cw.length * 8;
  let goingUp = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let rowCount = 0; rowCount < size; rowCount++) {
      for (let dc = 0; dc < 2; dc++) {
        const cc = col - dc;
        const rr = goingUp ? size - 1 - rowCount : rowCount;
        if (reserved[rr][cc]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          const byteIdx = bitIdx >> 3;
          const bib = 7 - (bitIdx & 7);
          bit = (cw[byteIdx] >> bib) & 1;
        }
        mat[rr][cc] = bit;
        bitIdx++;
      }
    }
    goingUp = !goingUp;
  }
}

function maskFn(m) {
  switch (m) {
    case 0: return (r, c) => (r + c) % 2 === 0;
    case 1: return (r) => r % 2 === 0;
    case 2: return (r, c) => c % 3 === 0;
    case 3: return (r, c) => (r + c) % 3 === 0;
    case 4: return (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}
function applyMask(mat, reserved, size, m) {
  const fn = maskFn(m);
  const out = mat.map(row => new Int8Array(row));
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!reserved[r][c] && fn(r, c)) out[r][c] ^= 1;
  }
  return out;
}

function formatInfoBits(mask) {
  // ECC M => eclBits = 0. data = (0 << 3) | mask
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return ((data << 10) | (rem & 0x3FF)) ^ 0x5412;
}
function placeFormat(mat, size, bits) {
  const g = (i) => (bits >> i) & 1;
  for (let i = 0; i < 6; i++) mat[8][i] = g(i);
  mat[8][7] = g(6);
  mat[8][8] = g(7);
  mat[7][8] = g(8);
  for (let i = 9; i < 15; i++) mat[14 - i][8] = g(i);
  for (let i = 0; i < 8; i++) mat[size - 1 - i][8] = g(i);
  for (let i = 8; i < 15; i++) mat[8][size - 15 + i] = g(i);
  mat[size - 8][8] = 1;
}

function penalty(mat, size) {
  let p = 0;
  // N1: runs of 5+
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1, prev = axis ? mat[0][i] : mat[i][0];
      for (let j = 1; j < size; j++) {
        const cur = axis ? mat[j][i] : mat[i][j];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else { run = 1; prev = cur; }
      }
    }
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = mat[r][c];
    if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) p += 3;
  }
  // N3: finder-like 10111010000 / 00001011101
  const pat1 = [1,0,1,1,1,0,1,0,0,0,0];
  const pat2 = [0,0,0,0,1,0,1,1,1,0,1];
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let m1 = true, m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = axis ? mat[j + k][i] : mat[i][j + k];
          if (v !== pat1[k]) m1 = false;
          if (v !== pat2[k]) m2 = false;
          if (!m1 && !m2) break;
        }
        if (m1) p += 40;
        if (m2) p += 40;
      }
    }
  }
  // N4: dark ratio
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mat[r][c]) dark++;
  const pct = dark * 100 / (size * size);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

export function qrSvg(text, opts = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const size = 21 + (version - 1) * 4;
  const cw = interleave(encodeToCodewords(bytes, version), version);
  const base = makeMatrix(version);
  placeData(base.mat, base.reserved, size, cw);
  let bestMat = null, bestScore = Infinity, bestMask = 0;
  for (let m = 0; m < 8; m++) {
    const masked = applyMask(base.mat, base.reserved, size, m);
    placeFormat(masked, size, formatInfoBits(m));
    const s = penalty(masked, size);
    if (s < bestScore) { bestScore = s; bestMat = masked; bestMask = m; }
  }
  const scale = opts.scale || 4;
  const margin = opts.margin != null ? opts.margin : 4;
  const total = (size + margin * 2) * scale;
  let rects = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (bestMat[r][c]) rects += `<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

// Optional convenience: return a data URL suitable for <img src=…>
export function svgDataUrl(svg) { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); }
