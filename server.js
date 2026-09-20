'use strict';
/**
 * Express Pick-Up — сервер прототипа.
 * Чистый Node, без зависимостей: статика + JSON API + SSE для живых экранов.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const store = require('./lib/store');
const seed = require('./lib/seed');
const capacity = require('./lib/capacity');
const orders = require('./lib/orders');
const analytics = require('./lib/analytics');
const qr = require('./lib/qr');
const geo = require('./lib/geo');
const poi = require('./lib/poi');
const calibration = require('./lib/calibration');

const PORT = Number(process.env.PORT) || 3000;
// Экраны кухни, выдачи и панели закрыты коротким кодом. Это не полноценная
// авторизация, а защита от случайного гостя, открывшего /admin с телефона.
const STAFF_PIN = String(process.env.STAFF_PIN || '2468');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// ---------- инициализация данных ----------
/**
 * Стартовые данные и миграция существующей базы.
 *
 * База переживает обновления кода, поэтому новые поля (координаты заведения,
 * таймаут неявки) нужно дописывать в уже сохранённые записи. Без этого
 * обновление ломает сервис на живых данных, хотя на чистой базе всё работает.
 */
function ensureSeed() {
  const db = store.load();
  if (!db.venues.length) {
    db.venues = seed.seedVenues();
    store.save({ type: 'seeded' });
    console.log('Загружены стартовые данные: 3 заведения');
    return;
  }

  const defaults = seed.seedVenues();
  let migrated = 0;
  for (const venue of db.venues) {
    const template = defaults.find(v => v.id === venue.id);
    if (!venue.location && template) { venue.location = template.location; migrated++; }
    for (const key of Object.keys(seed.DEFAULT_SETTINGS)) {
      if (venue.settings[key] === undefined) {
        venue.settings[key] = seed.DEFAULT_SETTINGS[key];
        migrated++;
      }
    }
  }
  if (migrated) {
    store.save({ type: 'migrated' });
    console.log(`Миграция базы: дописано полей — ${migrated}`);
  }
}

// ---------- утилиты ответа ----------
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // время выдачи всегда показывается в поясе заведения, а не устройства гостя
    'X-Server-Tz-Offset': String(new Date().getTimezoneOffset()),
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, code, message, extra) {
  sendJson(res, status, Object.assign({ error: code, message: message || code }, extra || {}));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 512 * 1024) { reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' })); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(Object.assign(new Error('bad_json'), { code: 'bad_json' })); }
    });
    req.on('error', reject);
  });
}

// ---------- SSE ----------
const clients = new Set();

function sseHandler(req, res, query) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`retry: 3000\n\n`);
  const client = { res, venueId: query.venue || null };
  clients.add(client);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* закрыто */ }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    if (c.venueId && event.venueId && c.venueId !== event.venueId) continue;
    try { c.res.write(data); } catch (e) { clients.delete(c); }
  }
}

store.bus.on('change', broadcast);

// ---------- публичное представление заведения ----------
function venuePublic(v) {
  return {
    id: v.id, name: v.name, kind: v.kind, address: v.address, pickupPoint: v.pickupPoint,
    location: v.location,
    status: capacity.venueStatus(v, store.orders(), Date.now()),
    settings: {
      slotMinutes: v.settings.slotMinutes,
      minLeadMinutes: v.settings.minLeadMinutes,
      horizonMinutes: v.settings.horizonMinutes,
      serviceHours: v.settings.serviceHours
    },
    menu: v.menu.map(i => ({
      id: i.id, name: i.name, category: i.category, desc: i.desc,
      price: i.price, prepSeconds: i.prepSeconds, available: i.available,
      modifiers: i.modifiers || []
    }))
  };
}

// ---------- ограничение перебора ----------
// Номера заказов короткие и последовательные, поэтому поиск по номеру
// обязан быть дорогим для перебора.
const lookupHits = new Map();
const LOOKUP_LIMIT = 15;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

function lookupAllowed(req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const entry = lookupHits.get(ip);
  if (!entry || now > entry.resetAt) {
    lookupHits.set(ip, { count: 1, resetAt: now + LOOKUP_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOOKUP_LIMIT;
}

// чистим карту, чтобы она не росла бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of lookupHits) if (now > entry.resetAt) lookupHits.delete(ip);
}, 5 * 60 * 1000).unref();

// ---------- доступ персонала ----------
const STAFF_PREFIXES = ['/api/kitchen', '/api/pickup', '/api/admin', '/api/demo', '/api/staff'];

function needsStaff(pathname) {
  return STAFF_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function hasStaffAccess(req, query) {
  const provided = req.headers['x-staff-pin'] || query.pin;
  return String(provided || '') === STAFF_PIN;
}

// ---------- маршруты API ----------
async function handleApi(req, res, pathname, query) {
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const now = Date.now();

  if (needsStaff(pathname) && !hasStaffAccess(req, query)) {
    return sendError(res, 401, 'staff_auth', 'Нужен код доступа персонала');
  }

  // GET /api/staff/check — проверка кода доступа для экранов персонала
  if (method === 'GET' && pathname === '/api/staff/check') {
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/impact — публичные агрегированные метрики для страницы «О проекте».
  // Только сводные числа, без состава заказов и контактов гостей.
  if (method === 'GET' && pathname === '/api/impact') {
    const rows = store.venues().map(v => {
      const r = analytics.report(v, store.orders(), now);
      return {
        venue: v.name,
        kind: v.kind,
        address: v.address,
        orders: r.totals.orders,
        express: r.totals.express,
        p90WaitSeconds: r.kpi.p90WaitSeconds,
        p90WaitCounterSeconds: r.kpi.p90WaitCounterSeconds,
        baselineWaitSeconds: r.kpi.baselineWaitSeconds,
        onTimePct: r.kpi.onTimePct,
        expressSharePeakPct: r.kpi.expressSharePeakPct,
        throughputGainPct: r.kpi.throughputGainPct,
        avgRating: r.kpi.avgRating
      };
    });
    // Проценты усредняем до целых, секунды и оценку — до десятых
    const avg = (key, decimals = 0) => {
      const vals = rows.map(r => r[key]).filter(v => v != null);
      if (!vals.length) return null;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const k = Math.pow(10, decimals);
      return Math.round(mean * k) / k;
    };
    return sendJson(res, 200, {
      venues: rows,
      totals: {
        orders: rows.reduce((a, r) => a + r.orders, 0),
        express: rows.reduce((a, r) => a + r.express, 0),
        p90WaitSeconds: avg('p90WaitSeconds'),
        p90WaitCounterSeconds: avg('p90WaitCounterSeconds'),
        baselineWaitSeconds: avg('baselineWaitSeconds'),
        onTimePct: avg('onTimePct'),
        expressSharePeakPct: avg('expressSharePeakPct'),
        throughputGainPct: avg('throughputGainPct'),
        avgRating: avg('avgRating', 1)
      },
      targets: { p90WaitSeconds: 120, expressSharePeakPct: 40, throughputGainPct: 25, onTimePct: 90, avgRating: 4.5 }
    });
  }

  // GET /api/traffic — суточный профиль загруженности дорог Алматы (модель)
  if (method === 'GET' && pathname === '/api/traffic') {
    return sendJson(res, 200, {
      hourly: geo.HOURLY_CONGESTION,
      freeFlowKmh: geo.FREE_FLOW_KMH,
      walkKmh: geo.WALK_KMH,
      source: 'model'
    });
  }

  // GET /api/poi?north=&south=&east=&west=&zoom=
  // Реальные точки общепита Алматы из OpenStreetMap — фон рынка вокруг пилота.
  // Отдаются только попавшие в видимую область и только начиная с масштаба,
  // на котором их можно различить: иначе это тысяча точек в одном пикселе.
  if (method === 'GET' && pathname === '/api/poi') {
    return sendJson(res, 200, poi.inBounds({
      north: Number(query.north), south: Number(query.south),
      east: Number(query.east), west: Number(query.west),
      zoom: Number(query.zoom), limit: Number(query.limit)
    }));
  }

  // GET /api/areas — районы Алматы для оценки времени в пути без геолокации
  if (method === 'GET' && pathname === '/api/areas') {
    return sendJson(res, 200, seed.ALMATY_AREAS);
  }

  // GET /api/venues[?lat=&lon=&mode=]
  // С координатами гостя каждая точка получает время в пути с учётом пробок,
  // а список сортируется по близости: «где поесть рядом со мной прямо сейчас».
  if (method === 'GET' && pathname === '/api/venues') {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const from = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    const mode = query.mode === 'walk' || query.mode === 'car' ? query.mode : null;

    const rows = store.venues().map(v => {
      const travel = from
        ? (mode ? geo.travelMinutes(from, v, now, mode) : geo.bestTravel(from, v, now))
        : null;
      return {
        id: v.id, name: v.name, kind: v.kind, address: v.address, pickupPoint: v.pickupPoint,
        location: v.location,
        serviceHours: v.settings.serviceHours,
        itemsAvailable: v.menu.filter(i => i.available).length,
        itemsTotal: v.menu.length,
        status: capacity.venueStatus(v, store.orders(), now),
        travel
      };
    });

    if (from) {
      // Ближе — выше, но закрытые точки уходят вниз при любом расстоянии
      rows.sort((a, b) => {
        if (a.status.openNow !== b.status.openNow) return a.status.openNow ? -1 : 1;
        const am = a.travel ? a.travel.minutes : Infinity;
        const bm = b.travel ? b.travel.minutes : Infinity;
        return am - bm;
      });
    }
    return sendJson(res, 200, rows);
  }

  // GET /api/venues/:id
  if (method === 'GET' && seg[1] === 'venues' && seg.length === 3) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    return sendJson(res, 200, venuePublic(v));
  }

  // POST /api/venues/:id/slots  { items: [...] }
  if (method === 'POST' && seg[1] === 'venues' && seg[3] === 'slots') {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const body = await readBody(req);
    let cart = [];
    try {
      cart = orders.linesToCart(orders.buildLines(v, body.items || []));
    } catch (e) {
      if (e.code === 'empty_cart') cart = [];
      else return sendError(res, 400, e.code, e.message, { itemId: e.itemId, groupId: e.groupId });
    }

    // Дорога гостя — такое же ограничение слота, как и мощность кухни
    let travel = null;
    const from = body.from;
    if (from && Number.isFinite(Number(from.lat)) && Number.isFinite(Number(from.lon))) {
      const point = { lat: Number(from.lat), lon: Number(from.lon) };
      travel = body.mode === 'walk' || body.mode === 'car'
        ? geo.travelMinutes(point, v, now, body.mode)
        : geo.bestTravel(point, v, now);
    }

    const result = capacity.availableSlots(v, store.orders(), cart, now, travel ? travel.minutes : 0);
    result.travel = travel;
    return sendJson(res, 200, result);
  }

  // POST /api/venues/:id/orders
  if (method === 'POST' && seg[1] === 'venues' && seg[3] === 'orders') {
    const body = await readBody(req);
    try {
      const order = orders.create(seg[2], body, now);
      const v = store.venue(seg[2]);
      return sendJson(res, 201, { order: orders.publicView(order, v), statusUrl: `/o/${order.token}` });
    } catch (e) {
      if (e instanceof orders.OrderError || e.code) {
        const status = ['unknown_venue'].includes(e.code) ? 404 : 409;
        return sendError(res, status, e.code, e.message, { itemId: e.itemId, groupId: e.groupId });
      }
      throw e;
    }
  }

  // GET /api/orders/:token
  if (method === 'GET' && seg[1] === 'orders' && seg.length === 3) {
    const o = store.orderByToken(seg[2]);
    if (!o) return sendError(res, 404, 'unknown_order', 'Заказ не найден');
    return sendJson(res, 200, orders.publicView(o, store.venue(o.venueId)));
  }

  // GET /api/orders/:token/qr.svg
  if (method === 'GET' && seg[1] === 'orders' && seg[3] === 'qr.svg') {
    const o = store.orderByToken(seg[2]);
    if (!o) return sendError(res, 404, 'unknown_order', 'Заказ не найден');
    const host = req.headers.host || `localhost:${PORT}`;
    const link = `http://${host}/o/${o.token}`;
    const svg = qr.toSvg(link, { scale: 6, quiet: 2 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  // POST /api/orders/:token/(arrived|cancel|rate)
  if (method === 'POST' && seg[1] === 'orders' && seg.length === 4) {
    const o = store.orderByToken(seg[2]);
    if (!o) return sendError(res, 404, 'unknown_order', 'Заказ не найден');
    const action = seg[3];
    try {
      if (action === 'arrived') orders.markArrived(o, now);
      else if (action === 'cancel') {
        if (['ready', 'picked_up'].includes(o.status)) return sendError(res, 409, 'too_late', 'Заказ уже готов — отмена только на стойке');
        orders.setStatus(o, 'cancelled', now);
      } else if (action === 'rate') {
        const body = await readBody(req);
        orders.rate(o, body.rating);
      } else return sendError(res, 404, 'unknown_action', 'Действие не найдено');
    } catch (e) {
      return sendError(res, 409, e.code || 'error', e.message);
    }
    return sendJson(res, 200, orders.publicView(o, store.venue(o.venueId)));
  }

  // GET /api/lookup?venue=...&code=... — публичный статус по номеру.
  // Токен здесь НЕ выдаётся: иначе перебор трёхзначных номеров открывал бы
  // чужие заказы вместе с именем, составом и возможностью их отменить.
  if (method === 'GET' && pathname === '/api/lookup') {
    if (!lookupAllowed(req)) {
      return sendError(res, 429, 'too_many_lookups', 'Слишком много попыток. Попробуйте позже');
    }
    const o = store.orderByCode(query.venue, query.code || '');
    if (!o) return sendError(res, 404, 'unknown_order', 'Заказ не найден');
    return sendJson(res, 200, orders.publicSummary(o, store.venue(o.venueId)));
  }

  // GET /api/kitchen/:venueId
  if (method === 'GET' && seg[1] === 'kitchen' && seg.length === 3) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const queue = store.orders()
      .filter(o => o.venueId === v.id && ['new', 'cooking', 'ready'].includes(o.status))
      .sort((a, b) => orders.cookByTs(a) - orders.cookByTs(b))
      .map(o => ({
        id: o.id, code: o.code, channel: o.channel, status: o.status,
        slotStart: o.slotStart, cookStart: o.cookStart, workSeconds: o.workSeconds,
        createdAt: o.createdAt, guestName: o.guestName, comment: o.comment,
        payment: o.payment, paymentStatus: o.paymentStatus, arrivedAt: o.arrivedAt,
        lines: o.lines.map(l => ({ name: l.name, qty: l.qty, optionNames: l.optionNames }))
      }));
    return sendJson(res, 200, {
      venue: { id: v.id, name: v.name, pickupPoint: v.pickupPoint },
      settings: v.settings,
      queue,
      forecast: capacity.forecast(v, store.orders(), now),
      serverTime: new Date(now).toISOString()
    });
  }

  // POST /api/kitchen/orders/:id/(advance|status)
  if (method === 'POST' && seg[1] === 'kitchen' && seg[2] === 'orders' && seg.length === 5) {
    const o = store.orderById(seg[3]);
    if (!o) return sendError(res, 404, 'unknown_order', 'Заказ не найден');
    try {
      if (seg[4] === 'advance') orders.advance(o, now);
      else if (seg[4] === 'status') {
        const body = await readBody(req);
        orders.setStatus(o, body.status, now);
      } else if (seg[4] === 'cancel') {
        const body = await readBody(req);
        orders.cancelByVenue(o, body.reason, now);
      } else if (seg[4] === 'no-show') {
        orders.markNoShow(o, now);
      } else return sendError(res, 404, 'unknown_action', 'Действие не найдено');
    } catch (e) {
      return sendError(res, 409, e.code || 'error', e.message);
    }
    return sendJson(res, 200, { ok: true, status: o.status, refund: o.refund });
  }

  // GET /api/pickup/:venueId
  if (method === 'GET' && seg[1] === 'pickup' && seg.length === 3) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const list = store.orders().filter(o => o.venueId === v.id);
    return sendJson(res, 200, {
      venue: { id: v.id, name: v.name, pickupPoint: v.pickupPoint },
      ready: list.filter(o => o.status === 'ready')
        .sort((a, b) => new Date(a.readyAt) - new Date(b.readyAt))
        .map(o => ({ id: o.id, code: o.code, guestName: o.guestName, readyAt: o.readyAt, arrivedAt: o.arrivedAt, paymentStatus: o.paymentStatus, total: o.total })),
      cooking: list.filter(o => ['new', 'cooking'].includes(o.status))
        .sort((a, b) => new Date(a.slotStart) - new Date(b.slotStart))
        .slice(0, 8)
        .map(o => ({ id: o.id, code: o.code, slotStart: o.slotStart })),
      recentlyPicked: list.filter(o => o.status === 'picked_up')
        .sort((a, b) => new Date(b.pickedUpAt) - new Date(a.pickedUpAt))
        .slice(0, 5)
        .map(o => ({ code: o.code, pickedUpAt: o.pickedUpAt })),
      serverTime: new Date(now).toISOString()
    });
  }

  // GET /api/admin/:venueId
  if (method === 'GET' && seg[1] === 'admin' && seg.length === 3) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    return sendJson(res, 200, {
      venue: { id: v.id, name: v.name, kind: v.kind, address: v.address, pickupPoint: v.pickupPoint },
      settings: v.settings,
      menu: v.menu,
      capacityPerSlotSeconds: capacity.slotCapacitySeconds(v.settings),
      report: analytics.report(v, store.orders(), now)
    });
  }

  // PUT /api/admin/:venueId/settings
  if (method === 'PUT' && seg[1] === 'admin' && seg[3] === 'settings') {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const body = await readBody(req);
    // Каждая настройка участвует в расчётах ёмкости: ноль в мощности кухни
    // или отрицательный лимит выдач ломают арифметику слотов молча.
    const BOUNDS = {
      slotMinutes: [1, 30],
      horizonMinutes: [15, 600],
      minLeadMinutes: [0, 120],
      kitchenThroughputPerMin: [1, 5000],
      digitalSharePct: [1, 100],
      maxOrdersPerSlot: [1, 100],
      maxEarlyCookSlots: [1, 48],
      graceSeconds: [0, 3600],
      noShowAfterMinutes: [1, 240],
      baselineWaitSeconds: [0, 7200],
      baselineOrdersPerHour: [1, 1000]
    };
    const rejected = [];
    for (const key of Object.keys(BOUNDS)) {
      if (body[key] == null) continue;
      const value = Number(body[key]);
      const [min, max] = BOUNDS[key];
      if (!Number.isFinite(value) || value < min || value > max) {
        rejected.push({ key, min, max });
        continue;
      }
      v.settings[key] = value;
    }
    if (typeof body.autoKitchen === 'boolean') v.settings.autoKitchen = body.autoKitchen;

    const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (body.serviceHours) {
      const from = String(body.serviceHours.from || '');
      const to = String(body.serviceHours.to || '');
      const minutes = hm => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
      if (!HM.test(from) || !HM.test(to) || minutes(to) <= minutes(from)) {
        rejected.push({ key: 'serviceHours' });
      } else {
        v.settings.serviceHours = { from, to };
      }
    }

    if (rejected.length) {
      return sendError(res, 400, 'bad_settings', 'Недопустимые значения настроек', { rejected });
    }
    store.save({ type: 'settings_updated', venueId: v.id });
    return sendJson(res, 200, { settings: v.settings, capacityPerSlotSeconds: capacity.slotCapacitySeconds(v.settings) });
  }

  // PUT /api/admin/:venueId/menu/:itemId
  if (method === 'PUT' && seg[1] === 'admin' && seg[3] === 'menu' && seg.length === 5) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const item = store.menuItem(v, seg[4]);
    if (!item) return sendError(res, 404, 'unknown_item', 'Позиция не найдена');
    const body = await readBody(req);
    if (typeof body.available === 'boolean') item.available = body.available;
    if (Number.isFinite(Number(body.price))) item.price = Math.max(0, Number(body.price));
    if (Number.isFinite(Number(body.prepSeconds))) item.prepSeconds = Math.max(0, Math.min(3600, Number(body.prepSeconds)));
    store.save({ type: 'menu_updated', venueId: v.id, itemId: item.id });
    return sendJson(res, 200, item);
  }

  // GET /api/admin/:venueId/calibration — сверка параметров с замерами
  if (method === 'GET' && seg[1] === 'admin' && seg[3] === 'calibration' && seg.length === 4) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    return sendJson(res, 200, calibration.report(v, store.orders(), now));
  }

  // POST /api/admin/:venueId/calibration/apply — принять предложенные значения
  if (method === 'POST' && seg[1] === 'admin' && seg[3] === 'calibration' && seg[4] === 'apply') {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const body = await readBody(req);
    const list = Array.isArray(body.items) ? body.items : [];
    const applied = [];
    for (const row of list) {
      const item = store.menuItem(v, row.itemId);
      const value = Number(row.prepSeconds);
      if (!item || !Number.isFinite(value) || value < 1 || value > 3600) continue;
      applied.push({ itemId: item.id, was: item.prepSeconds, now: Math.round(value) });
      item.prepSeconds = Math.round(value);
    }
    if (applied.length) store.save({ type: 'calibration_applied', venueId: v.id });
    return sendJson(res, 200, { applied });
  }

  // GET /api/admin/:venueId/report?day=-1
  if (method === 'GET' && seg[1] === 'admin' && seg[3] === 'report') {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const offset = Number(query.day) || 0;
    return sendJson(res, 200, analytics.report(v, store.orders(), now, offset));
  }

  // POST /api/demo/:venueId/(showcase|counter|rush|history|reset)
  if (method === 'POST' && seg[1] === 'demo' && seg.length === 4) {
    const v = store.venue(seg[2]);
    if (!v) return sendError(res, 404, 'unknown_venue', 'Заведение не найдено');
    const demo = require('./lib/demo');
    try {
      const body = await readBody(req);
      const result = demo.run(seg[3], v, now, body || {});
      return sendJson(res, 200, result);
    } catch (e) {
      return sendError(res, 400, e.code || 'error', e.message);
    }
  }

  return sendError(res, 404, 'not_found', 'Маршрут не найден');
}

// ---------- статика ----------
const PAGES = {
  '/': 'index.html',
  '/about': 'about.html',
  '/kitchen': 'kitchen.html',
  '/pickup': 'pickup.html',
  '/admin': 'admin.html'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  let query;
  try {
    // Разбор адреса обязан быть внутри защищённого блока: и конструктор URL,
    // и decodeURIComponent бросают на битом проценте («/%E0%A4%A»). Раньше это
    // происходило вне try и валило весь процесс — один запрос, и сервис лежит.
    const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    pathname = decodeURIComponent(parsed.pathname);
    query = Object.fromEntries(parsed.searchParams);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Некорректный адрес');
  }

  try {
    if (pathname === '/api/stream') return sseHandler(req, res, query);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, query);

    if (pathname.startsWith('/o/')) return serveFile(res, path.join(PUBLIC_DIR, 'order.html'));
    if (PAGES[pathname]) return serveFile(res, path.join(PUBLIC_DIR, PAGES[pathname]));

    // статические файлы, защита от выхода за пределы public/
    const target = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!target.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Запрещено');
    }
    return serveFile(res, target);
  } catch (e) {
    console.error('Ошибка запроса', pathname, e);
    if (!res.headersSent) sendError(res, 500, 'internal', e.message || 'Внутренняя ошибка');
    else res.end();
  }
});

// фоновый тик: автокухня в демо-режиме и развёртка незабранных заказов
setInterval(() => {
  const now = Date.now();
  try { orders.autoKitchenTick(now); } catch (e) { console.error('autoKitchen', e.message); }
  try { orders.sweepNoShows(now); } catch (e) { console.error('sweepNoShows', e.message); }
}, 5000).unref();

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// Последний рубеж. Любая необработанная ошибка в одном запросе не должна
// снимать сервис со всех экранов заведения: логируем громко и продолжаем.
// Это страховка, а не замена обработке ошибок в обработчиках.
process.on('uncaughtException', err => {
  console.error('[uncaughtException] сервис продолжает работу:', err && err.stack || err);
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection] сервис продолжает работу:', err && err.stack || err);
});

if (require.main === module) {
  ensureSeed();

  // Не сумев занять порт, сервис обязан упасть внятно. Иначе общий перехватчик
  // ошибок оставляет мёртвый процесс жить, а отвечает старый экземпляр — и на
  // запросы приходят ответы от кода, которого уже нет в файлах.
  server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\nПорт ${PORT} уже занят. Остановите запущенный сервер или задайте другой порт:`);
      console.error(`  PORT=${PORT + 1} node server.js\n`);
    } else {
      console.error('Не удалось запустить сервер:', err && err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    const addrs = ['localhost', ...localAddresses()];
    console.log('\n  Express Pick-Up — прототип запущен\n');
    for (const a of addrs) {
      console.log(`  Гость      http://${a}:${PORT}/`);
    }
    console.log(`  О проекте  http://localhost:${PORT}/about`);
    console.log(`  Кухня      http://localhost:${PORT}/kitchen  (код ${STAFF_PIN})`);
    console.log(`  Выдача     http://localhost:${PORT}/pickup`);
    console.log(`  Панель     http://localhost:${PORT}/admin\n`);

    // Расчёты слотов, часов работы и пробок идут в локальном поясе сервера.
    // Если сервис развёрнут не в том городе, где стоит касса, время поедет.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'не определён';
    const offset = -new Date().getTimezoneOffset() / 60;
    console.log(`  Часовой пояс сервера: ${tz} (UTC${offset >= 0 ? '+' : ''}${offset}).`);
    console.log('  Слоты и часы работы считаются в нём — он должен совпадать с поясом заведения.');
    if (STAFF_PIN === '2468') {
      console.log('  ВНИМАНИЕ: используется демонстрационный код персонала 2468.');
      console.log('  Для реального заведения задайте свой: STAFF_PIN=... node server.js\n');
    } else {
      console.log('');
    }
  });
}

module.exports = { server, ensureSeed };
