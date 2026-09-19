#!/usr/bin/env node
'use strict';
/**
 * Выгрузка точек общепита Алматы из OpenStreetMap через Overpass API.
 *
 * Зачем: карта пилота должна показывать реальный рынок, а не выдуманные точки.
 * Данные забираются один раз и кладутся в data/poi.json, чтобы сервис работал
 * без интернета и не бил по публичному API при каждом запуске.
 *
 *   node scripts/fetch-poi.js
 *
 * Лицензия данных: ODbL, © участники OpenStreetMap. Указание источника
 * обязательно и выводится в интерфейсе карты.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const OUT_FILE = path.join(__dirname, '..', 'data', 'poi.json');

// Форматы, которым осмысленна выдача навынос
const AMENITY = 'cafe|restaurant|fast_food|food_court|ice_cream|bar|pub|canteen';
const SHOP = 'bakery|coffee|confectionery|pastry|deli';

const QUERY = `
[out:json][timeout:180];
area["name"="Алматы"]["admin_level"="4"]->.a;
(
  node["amenity"~"^(${AMENITY})$"](area.a);
  way["amenity"~"^(${AMENITY})$"](area.a);
  node["shop"~"^(${SHOP})$"](area.a);
  way["shop"~"^(${SHOP})$"](area.a);
);
out center tags;
`;

function request(query) {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept-Encoding': 'gzip',
        'User-Agent': 'ExpressPickUp-Pilot/0.1 (hackathon prototype; contact: local)'
      }
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Overpass ответил ' + res.statusCode));
      }
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      let raw = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { raw += chunk; });
      stream.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Не удалось разобрать ответ Overpass')); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Человекочитаемый формат точки — по нему строится подсказка на карте. */
function kindOf(tags) {
  const map = {
    cafe: 'Кафе', restaurant: 'Ресторан', fast_food: 'Фастфуд',
    food_court: 'Фуд-корт', ice_cream: 'Мороженое', bar: 'Бар',
    pub: 'Паб', canteen: 'Столовая'
  };
  const shops = {
    bakery: 'Пекарня', coffee: 'Кофе', confectionery: 'Кондитерская',
    pastry: 'Кондитерская', deli: 'Деликатесы'
  };
  return map[tags.amenity] || shops[tags.shop] || 'Общепит';
}

(async () => {
  console.log('Запрашиваю точки общепита Алматы у Overpass…');
  let data;
  try {
    data = await request(QUERY);
  } catch (e) {
    console.error('Не удалось получить данные:', e.message);
    console.error('Файл data/poi.json оставлен без изменений.');
    process.exit(1);
  }

  const seen = new Set();
  const points = [];
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (lat == null || lon == null) continue;

    const name = (tags.name || tags['name:ru'] || tags.brand || '').trim();
    if (!name) continue; // безымянные точки на карте бесполезны

    // Дубли: одно заведение может быть и точкой, и контуром здания
    const key = name.toLowerCase() + '@' + lat.toFixed(4) + ',' + lon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);

    points.push({
      n: name.slice(0, 60),
      k: kindOf(tags),
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5
    });
  }

  points.sort((a, b) => a.lat - b.lat);

  const payload = {
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL, © участники OpenStreetMap',
    fetchedAt: new Date().toISOString(),
    city: 'Алматы',
    count: points.length,
    points
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload));
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`Сохранено точек: ${points.length} (${kb} КБ) → ${OUT_FILE}`);

  const byKind = {};
  for (const p of points) byKind[p.k] = (byKind[p.k] || 0) + 1;
  console.log('По форматам:');
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${v}`);
  }
})();
