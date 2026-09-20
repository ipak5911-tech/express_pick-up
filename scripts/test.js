#!/usr/bin/env node
'use strict';
/**
 * Сквозные тесты Express Pick-Up.
 *
 * Поднимают сервер на отдельном порту со своей базой, прогоняют сценарии
 * гостя, кухни, выдачи и панели, затем убирают за собой.
 *
 *   npm test
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.TEST_PORT) || 3911;
const PIN = '2468';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `epu-test-${process.pid}.json`);

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) { passed++; console.log('  ✓  ' + message); }
  else { failed++; console.log('  ✗  ' + message); }
}

function section(title) {
  console.log('\n' + title);
}

function request(method, urlPath, body, withPin = true) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (withPin) headers['X-Staff-Pin'] = PIN;
    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(BASE + urlPath, { method, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p, pin) => request('GET', p, null, pin);
const post = (p, body, pin) => request('POST', p, body, pin);
const put = (p, body, pin) => request('PUT', p, body, pin);

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      // письма в тестах никуда не уходят — только в журнал, который и проверяется
      env: Object.assign({}, process.env, { PORT: String(PORT), EPU_DB_FILE: DB_FILE, STAFF_PIN: PIN, MAIL_TRANSPORT: 'outbox' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Сервер не поднялся за 10 секунд')); }
    }, 10000);
    child.stdout.on('data', chunk => {
      if (!settled && String(chunk).includes('запущен')) {
        settled = true;
        clearTimeout(timer);
        setTimeout(() => resolve(child), 300);
      }
    });
    child.stderr.on('data', chunk => process.stderr.write('[сервер] ' + chunk));
    child.on('exit', code => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Сервер завершился с кодом ' + code)); }
    });
  });
}

async function run() {
  // Тесты не должны зависеть от времени суток: расширяем часы работы
  // тестового заведения на все сутки, иначе ночной прогон видит закрытую кухню.
  let r = await get('/api/venues', false);
  const testVenueId = r.data[0].id;
  await put(`/api/admin/${testVenueId}/settings`, { serviceHours: { from: '00:00', to: '23:59' } });

  // ---------- каталог и меню ----------
  section('Каталог и меню');
  r = await get('/api/venues', false);
  ok(r.status === 200 && r.data.length >= 8, `точек питания в каталоге: ${r.data.length}`);
  ok(r.data.every(v => v.location && v.status), 'у каждой точки есть координаты и живой статус');
  const venueId = r.data[0].id;
  const venue = r.data[0];
  const otherVenueId = r.data.find(v => v.id !== venueId).id;
  ok(venue.location && venue.location.lat > 43 && venue.location.lat < 44,
    `координаты Алматы у заведения (${venue.location.lat}, ${venue.location.lon})`);

  r = await get('/api/venues/' + venueId, false);
  ok(r.status === 200 && r.data.menu.length > 0, `меню загружено (${r.data.menu.length} позиций)`);

  // ---------- ёмкость слотов ----------
  section('Производственная ёмкость');
  const heavy = { items: [{ itemId: 'c-chicken', qty: 4, options: [] }, { itemId: 'c-beshbarmak', qty: 3, options: [] }] };
  r = await post(`/api/venues/${venueId}/slots`, heavy, false);
  ok(r.data.tooLarge === true, `заказ на ${Math.round(r.data.workSeconds / 60)} мин работы не помещается в окно приготовления`);

  const light = { items: [{ itemId: 'c-compote', qty: 1, options: [] }] };
  r = await post(`/api/venues/${venueId}/slots`, light, false);
  const freeSlots = r.data.slots.filter(s => s.available);
  ok(freeSlots.length > 0, `лёгкий заказ находит слоты (${freeSlots.length})`);
  const slot = freeSlots[0];

  // ---------- дорога гостя ----------
  section('Дорога гостя и пробки');
  r = await get('/api/areas', false);
  ok(r.status === 200 && r.data.length === 7, `районы Алматы (${r.data.length})`);
  const areas = r.data;
  const far = areas.find(a => a.id === 'turksib');
  const near = areas.find(a => a.id === 'bostandyk');

  r = await post(`/api/venues/${venueId}/slots`, Object.assign({ from: { lat: far.lat, lon: far.lon }, mode: 'car' }, light), false);
  const farTravel = r.data.travel;
  ok(farTravel && farTravel.minutes > 0, `время в пути из дальнего района: ${farTravel.minutes} мин (${farTravel.distanceKm} км)`);
  ok(r.data.slots.some(s => s.reason === 'too_far'), 'недостижимые слоты помечены причиной');

  r = await post(`/api/venues/${venueId}/slots`, Object.assign({ from: { lat: near.lat, lon: near.lon }, mode: 'car' }, light), false);
  ok(r.data.travel.minutes < farTravel.minutes,
    `из ближнего района быстрее: ${r.data.travel.minutes} < ${farTravel.minutes} мин`);

  r = await get('/api/traffic', false);
  ok(r.status === 200 && r.data.hourly.length === 24, 'суточный профиль пробок доступен');

  // Каталог с координатами гостя: «где поесть рядом со мной»
  r = await get(`/api/venues?lat=${far.lat}&lon=${far.lon}`, false);
  const nearList = r.data;
  ok(nearList.every(v => v.travel && v.travel.minutes > 0), 'каждая точка получила время в пути');
  const openOnly = nearList.filter(v => v.status.openNow).map(v => v.travel.minutes);
  const sortedByTime = openOnly.every((m, i) => i === 0 || openOnly[i - 1] <= m);
  ok(sortedByTime, `открытые точки отсортированы по близости: ${openOnly.join(' < ')} мин`);
  const closedIdx = nearList.findIndex(v => !v.status.openNow);
  const openIdx = nearList.findIndex(v => v.status.openNow);
  ok(closedIdx === -1 || openIdx === -1 || closedIdx > openIdx, 'закрытые точки уходят вниз списка');

  // Пешком там, где ехать бессмысленно
  const atCafe = nearList.find(v => v.id === 'coffeeboom-arbat');
  r = await get('/api/venues?lat=43.2603&lon=76.9453', false);
  const walkable = r.data.filter(v => v.travel.mode === 'walk');
  ok(walkable.length > 0, `рядом предлагается идти пешком: ${walkable.map(v => v.name + ' ' + v.travel.minutes + ' мин').join(', ')}`);

  r = await get('/api/venues', false);
  ok(r.data.every(v => v.travel === null), 'без координат время в пути не считается');

  // ---------- точки города ----------
  section('Справочные точки Алматы');
  r = await get('/api/poi?north=43.27&south=43.24&east=76.96&west=76.93&zoom=15', false);
  ok(r.status === 200 && r.data.total > 500, `подходящих по формату точек города: ${r.data.total}`);
  ok(r.data.totalAll > r.data.total,
    `рестораны, бары и пабы отфильтрованы: ${r.data.total} из ${r.data.totalAll}`);
  ok(r.data.points.every(p => !['Ресторан', 'Бар', 'Паб', 'Мороженое'].includes(p.k)),
    'в выдаче нет форматов без обеденного потока навынос');
  ok(r.data.shown > 0 && r.data.shown <= r.data.matched, `в видимой области отдано ${r.data.shown} из ${r.data.matched}`);
  ok(r.data.points.every(p => p.n && p.k && p.lat && p.lon), 'у каждой точки есть название, формат и координаты');
  ok(/ODbL/.test(r.data.license || ''), `лицензия данных указана: ${r.data.license}`);

  r = await get('/api/poi?north=43.4&south=43.1&east=77.1&west=76.8&zoom=11', false);
  ok(r.data.tooFar === true && r.data.shown === 0, `на мелком масштабе точки скрыты (порог зума ${r.data.minZoom})`);

  // Плотность должна расти вместе с приближением — в этом и смысл постепенности
  const density = [];
  for (const z of [12, 14, 16]) {
    const d = await get(`/api/poi?north=43.4&south=43.1&east=77.1&west=76.8&zoom=${z}`, false);
    density.push({ z, shown: d.data.shown });
  }
  ok(density[0].shown < density[1].shown && density[1].shown < density[2].shown,
    `точки густеют при приближении: ${density.map(d => 'зум ' + d.z + ' → ' + d.shown).join(', ')}`);
  ok(density[0].shown > 0, 'на обзорном виде точки уже видны');

  r = await get('/api/poi?north=43.27&south=43.24&east=76.96&west=76.93&zoom=15&limit=10', false);
  ok(r.data.shown === 10, 'ограничение количества соблюдается');

  r = await get('/api/poi?zoom=15', false);
  ok(r.data.shown === 0, 'без корректной области точки не отдаются');

  // ---------- оформление заказа ----------
  section('Оформление заказа');
  r = await post(`/api/venues/${venueId}/orders`, { items: [{ itemId: 'c-tea', qty: 1, options: [] }], slotStart: slot.start, payment: 'onsite' }, false);
  ok(r.status === 409 && r.data.error === 'modifier_required', 'обязательный модификатор требуется');

  const past = new Date(Math.floor((Date.now() - 600000) / 300000) * 300000).toISOString();
  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: past, payment: 'onsite' }, light), false);
  ok(r.status === 409 && r.data.error === 'slot_passed', 'слот в прошлом отклонён');

  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: new Date(Date.now() + 22 * 60000).toISOString(), payment: 'onsite' }, light), false);
  ok(r.status === 409 && r.data.error === 'bad_slot', 'невыровненный слот отклонён');

  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: slot.start, payment: 'online', name: 'Тест' }, light), false);
  ok(r.status === 201, `заказ создан: №${r.data.order.code} на ${slot.label}`);
  const token = r.data.order.token;
  const code = r.data.order.code;
  ok(r.data.order.total === 250, `цена в тенге: ${r.data.order.total}`);

  r = await get('/api/orders/' + token, false);
  ok(r.data.status === 'new' && r.data.paymentStatus === 'paid', 'статус и оплата записаны');

  r = await get(`/api/orders/${token}/qr.svg`, false);
  ok(r.status === 409 && r.data.error === 'qr_unavailable', 'QR-код скрыт, пока заказ не готов');

  // ---------- приватность номера заказа ----------
  section('Приватность');
  r = await get(`/api/lookup?venue=${venueId}&code=${code}`, false);
  ok(r.status === 200 && !r.data.token, 'поиск по номеру НЕ отдаёт токен');
  ok(!r.data.guestName && !r.data.lines, 'поиск по номеру НЕ отдаёт имя и состав заказа');
  ok(r.data.code === code && !!r.data.status, 'поиск по номеру отдаёт статус');

  let limited = false;
  for (let i = 0; i < 20; i++) {
    const probe = await get(`/api/lookup?venue=${venueId}&code=999`, false);
    if (probe.status === 429) { limited = true; break; }
  }
  ok(limited, 'перебор номеров упирается в ограничение попыток');

  // ---------- доступ персонала ----------
  section('Доступ персонала');
  for (const p of ['/api/staff/check', '/api/kitchen/' + venueId, '/api/admin/' + venueId]) {
    r = await get(p, false);
    ok(r.status === 401, `без кода ${p} → 401`);
  }
  r = await get('/api/staff/check');
  ok(r.status === 200, 'с кодом доступ открыт');
  r = await get('/api/impact', false);
  ok(r.status === 200, 'сводные метрики публичны');
  r = await get('/pickup', false);
  ok(r.status === 200 && String(r.data).includes('openScanner') && String(r.data).includes('vendor/jsQR.js'),
    'сканер встроен в приложение выдачи');

  // ---------- кухня и выдача ----------
  section('Кухня и выдача');
  r = await get('/api/kitchen/' + venueId);
  const queue = r.data.queue;
  ok(queue.some(o => o.code === code), `заказ в очереди кухни (${queue.length} всего)`);
  ok(Array.isArray(r.data.batches) && r.data.batches.length > 0,
    `сводка одинаковых позиций: ${r.data.batches.slice(0, 3).map(b => b.name + ' ×' + b.qty).join(', ')}`);
  const totalInBatches = r.data.batches.reduce((sum, b) => sum + b.qty, 0);
  const totalInQueue = queue.reduce((sum, o) => sum + o.lines.reduce((n, l) => n + l.qty, 0), 0);
  ok(totalInBatches === totalInQueue,
    `сводка учитывает все позиции очереди: ${totalInBatches} из ${totalInQueue}`);
  const sortedBatches = r.data.batches.every((b, i) => i === 0 || r.data.batches[i - 1].qty >= b.qty);
  ok(sortedBatches, 'сверху то, чего больше всего — его выгоднее готовить разом');

  const sorted = queue.every((o, i) => i === 0 ||
    new Date(queue[i - 1].cookStart || queue[i - 1].slotStart) <= new Date(o.cookStart || o.slotStart));
  ok(sorted, 'очередь отсортирована по времени начала готовки');

  const mine = queue.find(o => o.code === code);
  await post(`/api/kitchen/orders/${mine.id}/advance`);
  await post(`/api/kitchen/orders/${mine.id}/advance`);
  r = await get('/api/orders/' + token, false);
  ok(r.data.status === 'ready', 'заказ доведён до статуса «готов»');

  r = await get(`/api/orders/${token}/qr.svg`, false);
  ok(r.status === 200 && String(r.data).startsWith('<svg'), 'QR-код появился после готовности');

  r = await post(`/api/orders/${token}/cancel`, null, false);
  ok(r.status === 409, 'готовый заказ гость отменить не может');

  await post(`/api/orders/${token}/arrived`, null, false);
  r = await get('/api/pickup/' + venueId);
  ok(r.data.ready.some(o => o.code === code), 'заказ на табло выдачи');

  const ready = r.data.ready.find(o => o.code === code);
  // Ручная выдача остаётся рабочей: у гостя может сесть телефон
  await post(`/api/kitchen/orders/${ready.id}/status`, { status: 'picked_up' });
  r = await get('/api/orders/' + token, false);
  ok(r.data.status === 'picked_up', 'заказ выдан вручную, без QR');

  r = await post(`/api/orders/${token}/rate`, { rating: 5 }, false);
  ok(r.data.rating === 5, 'оценка сохранена');

  // ---------- подтверждение выдачи по QR ----------
  section('Выдача по QR-коду');
  const qrItems = { items: [{ itemId: 'c-compote', qty: 1, options: [] }] };
  r = await post(`/api/venues/${venueId}/slots`, qrItems, false);
  const qrSlot = r.data.slots.find(x => x.available);
  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: qrSlot.start, payment: 'online' }, qrItems), false);
  const qrToken = r.data.order.token;
  const qrCode = r.data.order.code;

  r = await get(`/api/orders/${qrToken}/qr.svg`, false);
  ok(r.status === 409 && r.data.error === 'qr_unavailable', 'QR заказа скрыт, пока он не готов');
  r = await get(`/handoff/${qrToken}`, false);
  ok(r.status === 200 && String(r.data).includes('handoff.js'), 'QR ведёт на страницу подтверждения выдачи');

  r = await post('/api/pickup/confirm', { token: qrToken }, false);
  ok(r.status === 401, 'подтверждение выдачи требует кода персонала');

  r = await post('/api/pickup/confirm', { token: qrToken });
  ok(r.status === 409 && r.data.error === 'order_not_ready', 'неготовый заказ по QR не выдаётся');

  r = await get('/api/kitchen/' + venueId);
  const qrOrder = r.data.queue.find(o => o.code === qrCode);
  await post(`/api/kitchen/orders/${qrOrder.id}/advance`);
  await post(`/api/kitchen/orders/${qrOrder.id}/advance`);

  r = await get(`/api/orders/${qrToken}/qr.svg`, false);
  ok(r.status === 200 && String(r.data).startsWith('<svg'), 'QR появился, когда заказ готов');

  r = await post('/api/pickup/confirm', { token: qrToken, venueId: otherVenueId });
  ok(r.status === 409 && r.data.error === 'wrong_venue', 'чужая точка не может выдать заказ');

  r = await post('/api/pickup/confirm', { token: qrToken, venueId });
  ok(r.status === 200 && r.data.issued && !r.data.alreadyIssued,
    `сканирование QR выдало заказ №${r.data.order.code}`);
  r = await post('/api/pickup/confirm', { token: qrToken });
  ok(r.data.alreadyIssued === true, 'повторное сканирование безопасно');

  r = await post('/api/pickup/confirm', { token: 'нетакойтокен' });
  ok(r.status === 400 && r.data.error === 'bad_qr', 'мусорный QR отклонён');

  r = await get('/api/orders/' + qrToken, false);
  ok(r.data.status === 'picked_up', 'гость видит, что заказ выдан');

  // ---------- письма гостю ----------
  section('Письма гостю');
  const mailItems = { items: [{ itemId: 'c-compote', qty: 2, options: [] }] };
  r = await post(`/api/venues/${venueId}/slots`, mailItems, false);
  const mailSlot = r.data.slots.find(x => x.available);
  r = await post(`/api/venues/${venueId}/orders`,
    Object.assign({ slotStart: mailSlot.start, payment: 'online', name: 'Айгерим', email: 'не-адрес' }, mailItems), false);
  ok(r.status === 400 && r.data.error === 'bad_email', 'кривая почта отклонена до создания заказа');

  r = await post(`/api/venues/${venueId}/orders`,
    Object.assign({ slotStart: mailSlot.start, payment: 'online', name: 'Айгерим', email: ' Guest@Example.COM ', lang: 'en' }, mailItems), false);
  ok(r.status === 201 && r.data.order.email === 'guest@example.com', 'почта сохранена и нормализована');
  const mailToken = r.data.order.token;
  const mailCode = r.data.order.code;
  await new Promise(res => setTimeout(res, 250));

  r = await get(`/api/admin/${venueId}/mail`, false);
  ok(r.status === 401, 'журнал писем закрыт кодом персонала');
  r = await get(`/api/admin/${venueId}/mail`);
  ok(r.status === 200 && r.data.mail.transport === 'outbox', 'в тестах письма только записываются');
  let letter = r.data.items.find(m => m.orderCode === mailCode && m.event === 'accepted');
  ok(!!letter && letter.to === 'guest@example.com' && letter.status === 'logged', 'письмо «заказ принят» записано');
  ok(!!letter && letter.preview.includes(`/o/${mailToken}`), 'в письме есть приватная ссылка на живой статус');
  ok(!!letter && /accepted/i.test(letter.subject), 'язык письма — язык гостя (en)');

  r = await get('/api/kitchen/' + venueId);
  const mailOrder = r.data.queue.find(o => o.code === mailCode);
  await post(`/api/kitchen/orders/${mailOrder.id}/advance`);
  await new Promise(res => setTimeout(res, 250));
  r = await get(`/api/admin/${venueId}/mail`);
  ok(!r.data.items.some(m => m.orderCode === mailCode && m.event === 'cooking'), '«готовится» письмом не рассылается');
  await post(`/api/kitchen/orders/${mailOrder.id}/advance`);
  await new Promise(res => setTimeout(res, 250));
  r = await get(`/api/admin/${venueId}/mail`);
  letter = r.data.items.find(m => m.orderCode === mailCode && m.event === 'ready');
  ok(!!letter && /ready/i.test(letter.subject), 'письмо «заказ готов» ушло при готовности');

  // подписка со страницы заказа — для тех, кто не указал почту сразу
  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: mailSlot.start, payment: 'onsite' }, mailItems), false);
  const lateToken = r.data.order.token;
  const lateCode = r.data.order.code;
  r = await post(`/api/orders/${lateToken}/email`, { email: 'oops' }, false);
  ok(r.status === 400 && r.data.error === 'bad_email', 'подписка с кривой почтой отклонена');
  r = await post(`/api/orders/${lateToken}/email`, { email: 'late@example.com', lang: 'ru' }, false);
  ok(r.status === 200 && r.data.email === 'late@example.com', 'почту можно указать после оформления');
  await new Promise(res => setTimeout(res, 250));
  r = await get(`/api/admin/${venueId}/mail`);
  letter = r.data.items.find(m => m.orderCode === lateCode);
  ok(!!letter && letter.event === 'accepted' && /принят/.test(letter.subject), 'после подписки сразу уходит письмо о текущем статусе');

  r = await post(`/api/admin/${venueId}/mail/test`, { to: 'staff@example.com' });
  ok(r.status === 200 && r.data.entry.status === 'logged', 'проверочное письмо из панели записано');

  const mailLib = require('../lib/mail');
  const raw = mailLib.buildMessage({ from: 'Express Pick-Up <a@b.kz>', to: 'g@x.kz', subject: 'Заказ №101 готов', text: 'т', html: '<b>т</b>', messageId: 'x1' });
  ok(/^Subject: =\?UTF-8\?B\?/m.test(raw) && /multipart\/alternative/.test(raw), 'тема в UTF-8 закодирована, письмо с текстом и HTML');

  // ---------- сценарии сбоев ----------
  section('Сценарии сбоев');
  r = await post(`/api/venues/${venueId}/slots`, light, false);
  const s2 = r.data.slots.find(x => x.available);
  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: s2.start, payment: 'online' }, light), false);
  const tok2 = r.data.order.token;
  const code2 = r.data.order.code;
  r = await get('/api/kitchen/' + venueId);
  const o2 = r.data.queue.find(o => o.code === code2);
  r = await post(`/api/kitchen/orders/${o2.id}/cancel`, { reason: 'Кончился продукт' });
  ok(r.status === 200 && r.data.refund === 'due', 'снятый оплаченный заказ помечен к возврату');
  r = await get('/api/orders/' + tok2, false);
  ok(r.data.cancelledBy === 'venue' && r.data.cancelReason === 'Кончился продукт', 'гость видит причину снятия');

  r = await post(`/api/venues/${venueId}/slots`, light, false);
  const s3 = r.data.slots.find(x => x.available);
  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: s3.start, payment: 'onsite' }, light), false);
  const code3 = r.data.order.code;
  r = await get('/api/kitchen/' + venueId);
  const o3 = r.data.queue.find(o => o.code === code3);
  r = await post(`/api/kitchen/orders/${o3.id}/no-show`);
  ok(r.status === 409, 'неявку нельзя отметить до готовности');
  await post(`/api/kitchen/orders/${o3.id}/advance`);
  await post(`/api/kitchen/orders/${o3.id}/advance`);
  r = await post(`/api/kitchen/orders/${o3.id}/no-show`);
  ok(r.status === 200 && r.data.status === 'no_show', 'незабранный заказ снят с табло');

  // ---------- калибровка ----------
  section('Калибровка по замерам');
  // Неделя истории: за один обед набрать статистику по каждой позиции нельзя
  r = await post(`/api/demo/${venueId}/history`, { days: 7 });
  ok(r.status === 200 && r.data.created > 100, `сгенерировано заказов за ${r.data.days} дней: ${r.data.created}`);
  r = await get(`/api/admin/${venueId}/calibration`);
  ok(r.status === 200 && Array.isArray(r.data.items), `позиций в отчёте калибровки: ${r.data.items.length}`);
  ok(r.data.items.every(i => i.samples === 0 || i.observed > 0), 'у позиций с замерами есть измеренное значение');
  const offItems = r.data.items.filter(i => ['underestimated', 'overestimated'].includes(i.verdict));
  ok(offItems.length > 0,
    `найдены расхождения: ${offItems.map(i => i.name + ' ' + (i.deltaPct > 0 ? '+' : '') + i.deltaPct + '%').join(', ')}`);
  ok(offItems.every(i => i.samples >= r.data.minSamples),
    `расхождения объявляются только при ${r.data.minSamples}+ замерах`);
  ok(['too_early', 'no_data', 'matches', 'idle', 'kitchen_behind', 'underconfigured'].includes(r.data.throughput.verdict),
    `вывод по производительности: ${r.data.throughput.verdict}`);

  const target = offItems[0];
  const before = target.current;
  r = await post(`/api/admin/${venueId}/calibration/apply`, { items: [{ itemId: target.itemId, prepSeconds: target.suggested }] });
  ok(r.status === 200 && r.data.applied.length === 1,
    `значение принято: ${target.name} ${before}с → ${target.suggested}с`);
  r = await get('/api/venues/' + venueId, false);
  const updated = r.data.menu.find(i => i.id === target.itemId);
  ok(updated.prepSeconds === target.suggested, 'новое время приготовления сохранено в меню');
  await put(`/api/admin/${venueId}/menu/${target.itemId}`, { prepSeconds: before });

  r = await post(`/api/admin/${venueId}/calibration/apply`, { items: [{ itemId: 'нет-такой', prepSeconds: 50 }] });
  ok(r.data.applied.length === 0, 'несуществующая позиция игнорируется');

  // ---------- настройки ----------
  section('Настройки и стоп-лист');
  for (const bad of [{ kitchenThroughputPerMin: 0 }, { maxOrdersPerSlot: -5 },
                     { digitalSharePct: 500 }, { serviceHours: { from: '19:00', to: '09:00' } },
                     { slotMinutes: 'abc' }]) {
    r = await put(`/api/admin/${venueId}/settings`, bad);
    ok(r.status === 400 && r.data.error === 'bad_settings',
      `отклонено: ${JSON.stringify(bad)}`);
  }
  r = await put(`/api/admin/${venueId}/settings`, { digitalSharePct: 5, maxOrdersPerSlot: 1 });
  ok(r.status === 200, 'корректные настройки приняты');
  r = await post(`/api/venues/${venueId}/slots`, heavy, false);
  ok(r.data.slots.filter(s => s.available).length === 0, 'при 5% мощности тяжёлый заказ не находит слотов');
  await put(`/api/admin/${venueId}/settings`, { digitalSharePct: 30, maxOrdersPerSlot: 5 });

  await put(`/api/admin/${venueId}/menu/c-compote`, { available: false });
  r = await post(`/api/venues/${venueId}/orders`, Object.assign({ slotStart: slot.start, payment: 'onsite' }, light), false);
  ok(r.status === 409 && r.data.error === 'stop_list', 'стоп-лист блокирует заказ');
  await put(`/api/admin/${venueId}/menu/c-compote`, { available: true });

  // ---------- демонстрация для жюри ----------
  section('Детерминированная демонстрация');
  const runShowcase = async () => {
    await post(`/api/demo/${venueId}/showcase`);
    const rep = await get(`/api/admin/${venueId}`);
    return rep.data.report;
  };

  const first = await runShowcase();
  const second = await runShowcase();
  ok(JSON.stringify(first.kpi) === JSON.stringify(second.kpi),
    `повторный запуск даёт те же KPI (p90=${second.kpi.p90WaitSeconds}с, рост=${second.kpi.throughputGainPct}%)`);

  const k = second.kpi, tg = second.targets;
  ok(k.p90WaitSeconds <= tg.p90WaitSeconds, `p90 ожидания ${k.p90WaitSeconds}с ≤ ${tg.p90WaitSeconds}с`);
  ok(k.onTimePct >= tg.onTimePct, `готовы вовремя ${k.onTimePct}% ≥ ${tg.onTimePct}%`);
  ok(k.expressSharePeakPct >= tg.expressSharePeakPct, `доля Express ${k.expressSharePeakPct}% ≥ ${tg.expressSharePeakPct}%`);
  ok(k.throughputGainPct >= tg.throughputGainPct, `рост выдач ${k.throughputGainPct}% ≥ ${tg.throughputGainPct}%`);
  ok(k.avgRating >= tg.avgRating, `оценка выдачи ${k.avgRating} ≥ ${tg.avgRating}`);
  ok(k.p90WaitCounterSeconds > k.p90WaitSeconds * 5,
    `касса заметно медленнее: ${Math.round(k.p90WaitCounterSeconds / 60)} мин против ${k.p90WaitSeconds}с`);

  ok(second.meta && second.meta.demoData === true && second.meta.sampleSize > 0,
    `отчёт помечен как симуляция, выборка ${second.meta.sampleSize}`);

  r = await get(`/api/admin/${venueId}`);
  ok(r.data.settings.autoKitchen === false, 'автопилот кухни выключен — статусы двигает человек');
  ok(r.data.settings.serviceHours.from === '00:00' && r.data.settings.serviceHours.to === '23:59',
    'часы работы расширены на сутки — показ не упрётся в закрытое заведение');

  const prep = await post(`/api/demo/${venueId}/showcase`);
  ok(prep.data.report && prep.data.report.p90WaitSeconds <= 120,
    `подготовка сразу возвращает KPI: p90 ${prep.data.report.p90WaitSeconds}с`);
  ok(prep.data.breakdown.freeSlots >= 3,
    `для заказа жюри оставлено свободных интервалов: ${prep.data.breakdown.freeSlots}`);
  ok(second.meta.demoOrders === second.meta.sampleSize && second.meta.realOrders === 0,
    `все заказы помечены демонстрационными: ${second.meta.demoOrders} из ${second.meta.sampleSize}`);

  // Гарантированный стресс-тест: закрывает именно ближайший слот
  const st = (await post(`/api/demo/${venueId}/stress`)).data;
  ok(st.targetSlot && st.created > 0 && st.created <= 12,
    `нагрузка на слот ${st.targetSlot}: ${st.created} заказов, предел 12 соблюдён`);
  ok(st.closedSlots.includes(st.targetSlot),
    `целевой слот ${st.targetSlot} действительно закрылся`);
  ok(st.nextAvailable && st.nextAvailable > st.targetSlot,
    `предложена альтернатива позже: ${st.nextAvailable}`);

  // Стресс-тест: жюри создаёт наплыв и видит, что времена закрываются
  await post(`/api/demo/${venueId}/showcase`);
  const rushOne = await post(`/api/demo/${venueId}/rush`);
  ok(rushOne.data.created > 0, `наплыв принят: ${rushOne.data.created} заказов`);
  ok(rushOne.data.availableAfter <= rushOne.data.availableBefore,
    `доступных времён стало не больше: ${rushOne.data.availableBefore} → ${rushOne.data.availableAfter}`);
  ok(Array.isArray(rushOne.data.closedSlots) && rushOne.data.closedSlots.length > 0,
    `закрылись времена: ${rushOne.data.closedSlots.join(', ')}`);

  let saturated = rushOne.data;
  for (let i = 0; i < 6 && !saturated.saturated; i++) {
    saturated = (await post(`/api/demo/${venueId}/rush`)).data;
  }
  ok(saturated.saturated === true,
    'при исчерпании мощности система отказывается принимать заказы, а не обещает невыполнимое');

  // ---------- устойчивость ----------
  section('Устойчивость');
  for (const badUrl of ['/%E0%A4%A', '/%', '/api/%ZZ']) {
    r = await get(badUrl, false);
    ok(r.status === 400, `битый адрес ${badUrl} → 400, а не падение`);
  }
  r = await get('/', false);
  ok(r.status === 200, 'сервер жив после битых адресов');
  r = await get('/../server.js', false);
  ok(String(r.data).indexOf('require(') === -1, 'выход за пределы public закрыт');
  r = await get('/api/nope', false);
  ok(r.status === 404, 'неизвестный маршрут → 404');

  // ---------- QR ----------
  section('QR-коды');
  const qr = require('../lib/qr');
  let qrOk = 0;
  const samples = ['A', 'http://localhost:3000/o/abcdefghijkl', 'Express Pick-Up — заказ №247', 'x'.repeat(213)];
  for (const sample of samples) {
    const m = qr.generate(sample);
    if (m.size === m.version * 4 + 17 && m.modules.length === m.size) qrOk++;
  }
  ok(qrOk === samples.length, `матрицы построены для всех образцов (${qrOk}/${samples.length})`);

  const jsQR = require('../public/assets/vendor/jsQR.js');
  const scanValue = 'http://localhost:3000/handoff/abcdefghijkl';
  const generated = qr.generate(scanValue);
  const quiet = 4;
  const scale = 7;
  const imageSize = (generated.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(imageSize * imageSize * 4);
  pixels.fill(255);
  for (let row = 0; row < generated.size; row++) {
    for (let col = 0; col < generated.size; col++) {
      if (!generated.modules[row][col]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = ((row + quiet) * scale + y) * imageSize + ((col + quiet) * scale + x);
          pixels[px * 4] = 0;
          pixels[px * 4 + 1] = 0;
          pixels[px * 4 + 2] = 0;
        }
      }
    }
  }
  const decoded = jsQR(pixels, imageSize, imageSize, { inversionAttempts: 'attemptBoth' });
  ok(decoded && decoded.data === scanValue, 'сканер распознаёт QR-код выдачи');
}

(async () => {
  let server;
  try {
    server = await startServer();
    await run();
  } catch (e) {
    failed++;
    console.error('\nОшибка выполнения тестов:', e && e.message);
  } finally {
    if (server) server.kill('SIGKILL');
    try { fs.unlinkSync(DB_FILE); } catch (e) { /* уже нет */ }
  }
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`Пройдено: ${passed}   Провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
