'use strict';
/**
 * Минимальный генератор QR-кодов без зависимостей.
 * Режим: byte (UTF-8), уровень коррекции M, версии 1–10.
 * Используется для QR-подтверждения выдачи заказа (ссылка на статус).
 */

// ---------- Поле Галуа GF(256), примитивный многочлен 0x11d ----------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const buf = data.slice();
  const res = new Array(ecLen).fill(0);
  for (let i = 0; i < buf.length; i++) {
    const factor = buf[i] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

// ---------- Таблицы версий (уровень коррекции M) ----------
// [всего кодовых слов, EC-слов на блок, [ [блоков, данных в блоке], ... ] ]
const VERSIONS_M = {
  1:  [26,  10, [[1, 16]]],
  2:  [44,  16, [[1, 28]]],
  3:  [70,  26, [[1, 44]]],
  4:  [100, 18, [[2, 32]]],
  5:  [134, 24, [[2, 43]]],
  6:  [172, 16, [[4, 27]]],
  7:  [196, 18, [[4, 31]]],
  8:  [242, 22, [[2, 38], [2, 39]]],
  9:  [292, 22, [[3, 36], [2, 37]]],
  10: [346, 26, [[4, 43], [1, 44]]]
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

// Остаточные биты после кодовых слов
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

const EC_LEVEL_M_BITS = 0b00; // индикатор уровня M в информации о формате

function dataCodewords(version) {
  const [, ecPerBlock, groups] = VERSIONS_M[version];
  let blocks = 0;
  let total = 0;
  for (const [count, dc] of groups) { blocks += count; total += count * dc; }
  return { total, blocks, ecPerBlock };
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const { total } = dataCodewords(v);
    const headerBits = 4 + charCountBits(v);
    if (total * 8 >= headerBits + byteLen * 8) return v;
  }
  throw new Error('QR: слишком длинные данные для версий 1–10');
}

// ---------- Кодирование данных ----------
function encodeData(bytes, version) {
  const { total } = dataCodewords(version);
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                       // режим byte
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);

  const capacity = total * 8;
  push(0, Math.min(4, capacity - bits.length)); // терминатор
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const PAD = [0xec, 0x11];
  let p = 0;
  while (codewords.length < total) codewords.push(PAD[p++ % 2]);
  return codewords;
}

function interleave(codewords, version) {
  const [, ecPerBlock, groups] = VERSIONS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, dc] of groups) {
    for (let i = 0; i < count; i++) {
      const data = codewords.slice(offset, offset + dc);
      offset += dc;
      blocks.push({ data, ec: rsRemainder(data, ecPerBlock) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

// ---------- Построение матрицы ----------
function newMatrix(size) {
  const modules = [];
  const reserved = [];
  for (let i = 0; i < size; i++) {
    modules.push(new Array(size).fill(0));
    reserved.push(new Array(size).fill(false));
  }
  return { size, modules, reserved };
}

function setFunction(m, row, col, value) {
  if (row < 0 || col < 0 || row >= m.size || col >= m.size) return;
  m.modules[row][col] = value;
  m.reserved[row][col] = true;
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.size || cc >= m.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setFunction(m, rr, cc, inRing || inCore ? 1 : 0);
    }
  }
}

function placeAlignment(m, version) {
  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      // пропускаем позиции, накрытые поисковыми узорами
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= m.size - 9) || (r >= m.size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunction(m, r + dr, c + dc, isDark ? 1 : 0);
        }
      }
    }
  }
}

function placePatterns(m, version) {
  placeFinder(m, 0, 0);
  placeFinder(m, 0, m.size - 7);
  placeFinder(m, m.size - 7, 0);

  for (let i = 8; i < m.size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setFunction(m, 6, i, v);
    setFunction(m, i, 6, v);
  }

  placeAlignment(m, version);

  // тёмный модуль
  setFunction(m, 4 * version + 9, 8, 1);

  // резерв под информацию о формате
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { setFunction(m, 8, i, 0); setFunction(m, i, 8, 0); }
  }
  for (let i = 0; i < 8; i++) {
    setFunction(m, 8, m.size - 1 - i, 0);
    setFunction(m, m.size - 1 - i, 8, 0);
  }

  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      setFunction(m, m.size - 11 + b, a, bit);
      setFunction(m, a, m.size - 11 + b, bit);
    }
  }
}

function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return ((version << 12) | rem) >>> 0;
}

function formatInfoBits(maskIdx) {
  const data = (EC_LEVEL_M_BITS << 3) | maskIdx;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return (((data << 10) | rem) ^ 0x5412) >>> 0;
}

function placeFormatInfo(m, maskIdx) {
  const bits = formatInfoBits(maskIdx);
  // Порядок укладки — от старшего бита к младшему: старший стоит в (8,0),
  // младший — в (0,8). Раньше биты шли в обратном порядке, и хотя само
  // значение было верным, ни один сторонний сканер такой код не читал.
  // Собственный декодер ошибку не ловил — он читал их тем же порядком.
  const bit = k => (bits >> (14 - k)) & 1;

  for (let k = 0; k <= 5; k++) setFunction(m, 8, k, bit(k));
  setFunction(m, 8, 7, bit(6));
  setFunction(m, 8, 8, bit(7));
  setFunction(m, 7, 8, bit(8));
  for (let k = 9; k < 15; k++) setFunction(m, 14 - k, 8, bit(k));

  // вторая копия: биты 0–6 — левый нижний столбец, биты 7–14 — правая верхняя строка
  for (let k = 0; k < 7; k++) setFunction(m, m.size - 1 - k, 8, bit(k));
  for (let k = 7; k < 15; k++) setFunction(m, 8, m.size - 15 + k, bit(k));
  setFunction(m, m.size - 8, 8, 1); // тёмный модуль
}

function placeData(m, bitStream) {
  let idx = 0;
  let upward = true;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // столбец тайминга пропускается
    for (let step = 0; step < m.size; step++) {
      const row = upward ? m.size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (m.reserved[row][col]) continue;
        m.modules[row][col] = idx < bitStream.length ? bitStream[idx] : 0;
        idx++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function applyMask(m, maskIdx) {
  const fn = MASKS[maskIdx];
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.reserved[r][c] && fn(r, c)) m.modules[r][c] ^= 1;
    }
  }
}

function penalty(m) {
  const n = m.size;
  let score = 0;

  // Правило 1: серии одинаковых модулей
  for (let r = 0; r < n; r++) {
    let runColor = m.modules[r][0], runLen = 1;
    for (let c = 1; c < n; c++) {
      if (m.modules[r][c] === runColor) runLen++;
      else { if (runLen >= 5) score += runLen - 2; runColor = m.modules[r][c]; runLen = 1; }
    }
    if (runLen >= 5) score += runLen - 2;
  }
  for (let c = 0; c < n; c++) {
    let runColor = m.modules[0][c], runLen = 1;
    for (let r = 1; r < n; r++) {
      if (m.modules[r][c] === runColor) runLen++;
      else { if (runLen >= 5) score += runLen - 2; runColor = m.modules[r][c]; runLen = 1; }
    }
    if (runLen >= 5) score += runLen - 2;
  }

  // Правило 2: блоки 2x2
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m.modules[r][c];
      if (v === m.modules[r][c + 1] && v === m.modules[r + 1][c] && v === m.modules[r + 1][c + 1]) score += 3;
    }
  }

  // Правило 3: узор 1:1:3:1:1 с отступом
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, start) => {
    let ok1 = true, ok2 = true;
    for (let i = 0; i < 11; i++) {
      const v = get(start + i);
      if (v !== pat1[i]) ok1 = false;
      if (v !== pat2[i]) ok2 = false;
    }
    return ok1 || ok2;
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c + 11 <= n; c++) if (matches(i => m.modules[r][i], c)) score += 40;
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r + 11 <= n; r++) if (matches(i => m.modules[i][c], r)) score += 40;
  }

  // Правило 4: баланс тёмных модулей
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m.modules[r][c];
  const ratio = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/** Возвращает { size, modules: number[][] } */
function generate(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(bytes.length);
  const codewords = encodeData(bytes, version);
  const finalCodewords = interleave(codewords, version);

  const bitStream = [];
  for (const cw of finalCodewords) for (let i = 7; i >= 0; i--) bitStream.push((cw >> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]; i++) bitStream.push(0);

  const size = version * 4 + 17;
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = newMatrix(size);
    placePatterns(m, version);
    placeData(m, bitStream);
    applyMask(m, mask);
    placeFormatInfo(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, m, mask };
  }
  return { size, version, mask: best.mask, modules: best.m.modules };
}

/** SVG-представление QR-кода */
function toSvg(text, opts = {}) {
  const { modules, size } = generate(text);
  const quiet = opts.quiet == null ? 2 : opts.quiet;
  const scale = opts.scale || 8;
  const total = (size + quiet * 2) * scale;
  const dark = opts.dark || '#101418';
  const light = opts.light || '#ffffff';
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR-код заказа">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`;
}

module.exports = { generate, toSvg };
