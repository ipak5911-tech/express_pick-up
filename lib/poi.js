'use strict';
/**
 * Справочные точки общепита Алматы из OpenStreetMap.
 *
 * Это фон рынка, а не участники сервиса: заказать в них нельзя, у них нет
 * меню и слотов. Показываются, чтобы масштаб задачи был виден — в городе
 * больше полутора тысяч точек, а к Express Pick-Up подключено восемь.
 *
 * Данные выгружаются скриптом scripts/fetch-poi.js и лежат в репозитории,
 * поэтому карта работает без обращения к внешнему API.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'poi.json');

/**
 * Ниже этого масштаба карта охватывает весь город, и точки перестают нести
 * смысл. На обзорном виде их показываем, но разрежённо.
 */
const MIN_ZOOM = 12;
const MAX_LIMIT = 1200;

/**
 * Сколько точек отдавать на каждом масштабе.
 *
 * Смысл в постепенности: на обзорном виде нужна плотность рынка, а не каждая
 * вывеска; по мере приближения проявляются остальные. Поэтому лимит растёт
 * вместе с зумом, а выборка делается равномерной, а не первыми попавшимися —
 * иначе точки сбились бы в один угол области.
 */
function limitForZoom(zoom) {
  if (zoom >= 17) return 900;
  if (zoom >= 16) return 700;
  if (zoom >= 15) return 500;
  if (zoom >= 14) return 350;
  if (zoom >= 13) return 220;
  return 140;
}

/** Равномерная выборка: берём каждую k-ю точку, а не первые n подряд. */
function sample(list, limit) {
  if (list.length <= limit) return list;
  const step = list.length / limit;
  const out = [];
  for (let i = 0; out.length < limit; i += step) out.push(list[Math.floor(i)]);
  return out;
}

/**
 * Форматы, которым осмыслен предзаказ обеда навынос.
 *
 * Ресторан, бар, паб, мороженое и кондитерская в список не входят: там нет
 * обеденного потока навынос, ради которого существует сервис. Показывать их
 * как потенциальных участников значило бы завышать рынок.
 */
const TARGET_KINDS = new Set(['Столовая', 'Фастфуд', 'Кафе', 'Фуд-корт', 'Пекарня', 'Кофе']);

let cache = null;

function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    raw = { count: 0, points: [], source: null, license: null };
  }
  const fitting = (raw.points || []).filter(p => TARGET_KINDS.has(p.k));
  cache = {
    license: raw.license,
    source: raw.source,
    totalAll: raw.count || (raw.points || []).length,
    count: fitting.length,
    points: fitting
  };
  return cache;
}

function total() {
  return load().count || 0;
}

/**
 * Точки внутри видимой области.
 * Возвращает сколько всего попало в область и сколько отдано: интерфейс
 * должен честно показывать, что список подрезан, а не молчать об этом.
 */
function inBounds(opts) {
  const data = load();
  const zoom = Number.isFinite(opts.zoom) ? opts.zoom : MIN_ZOOM;

  if (zoom < MIN_ZOOM) {
    return { minZoom: MIN_ZOOM, zoom, tooFar: true, total: data.count, totalAll: data.totalAll, matched: 0, shown: 0, points: [], license: data.license };
  }

  const { north, south, east, west } = opts;
  if (![north, south, east, west].every(Number.isFinite) || north <= south || east <= west) {
    return { minZoom: MIN_ZOOM, zoom, tooFar: false, total: data.count, totalAll: data.totalAll, matched: 0, shown: 0, points: [], license: data.license };
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1,
    Number.isFinite(opts.limit) ? opts.limit : limitForZoom(zoom)));
  const matched = [];
  for (const p of data.points) {
    if (p.lat < south || p.lat > north || p.lon < west || p.lon > east) continue;
    matched.push(p);
    if (matched.length > MAX_LIMIT) break;
  }

  const points = sample(matched, limit);
  return {
    minZoom: MIN_ZOOM,
    zoom,
    tooFar: false,
    total: data.count,
    totalAll: data.totalAll,
    matched: matched.length,
    shown: points.length,
    points,
    license: data.license
  };
}

module.exports = { inBounds, total, limitForZoom, MIN_ZOOM, FILE };
