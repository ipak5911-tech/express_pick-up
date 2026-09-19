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

/** Ниже этого масштаба точки сливаются в кашу и только мешают. */
const MIN_ZOOM = 14;
const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 1200;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    cache = { count: 0, points: [], source: null, license: null };
  }
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
    return { minZoom: MIN_ZOOM, zoom, tooFar: true, total: data.count, matched: 0, shown: 0, points: [], license: data.license };
  }

  const { north, south, east, west } = opts;
  if (![north, south, east, west].every(Number.isFinite) || north <= south || east <= west) {
    return { minZoom: MIN_ZOOM, zoom, tooFar: false, total: data.count, matched: 0, shown: 0, points: [], license: data.license };
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT));
  const matched = [];
  for (const p of data.points) {
    if (p.lat < south || p.lat > north || p.lon < west || p.lon > east) continue;
    matched.push(p);
    if (matched.length > MAX_LIMIT) break;
  }

  return {
    minZoom: MIN_ZOOM,
    zoom,
    tooFar: false,
    total: data.count,
    matched: matched.length,
    shown: Math.min(matched.length, limit),
    points: matched.slice(0, limit),
    license: data.license
  };
}

module.exports = { inBounds, total, MIN_ZOOM, FILE };
