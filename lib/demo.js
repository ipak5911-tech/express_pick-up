'use strict';
/** Демо-инструменты: имитация потока с кассы, наплыва цифровых заказов, сброса дня. */
const store = require('./store');
const capacity = require('./capacity');
const orders = require('./orders');

const NAMES = ['Анна', 'Марат', 'Ирина', 'Дмитрий', 'Айгуль', 'Пётр', 'Камила', 'Сергей', 'Ольга', 'Тимур', 'Юлия', 'Никита'];

function rnd(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[rnd(arr.length)]; }
function gauss(mean, sd) {
  const u = 1 - Math.random(), v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Случайная корзина из доступного меню с корректными обязательными модификаторами. */
function randomCart(venue, maxLines = 3) {
  const pool = venue.menu.filter(i => i.available);
  if (!pool.length) return [];
  const count = 1 + rnd(Math.min(maxLines, pool.length));
  const chosen = new Set();
  const cart = [];
  while (cart.length < count) {
    const item = pick(pool);
    if (chosen.has(item.id)) continue;
    chosen.add(item.id);
    const options = [];
    for (const grp of item.modifiers || []) {
      if (grp.required && grp.options.length) options.push(pick(grp.options).id);
      else if (grp.options.length && Math.random() < 0.3) options.push(pick(grp.options).id);
    }
    cart.push({ itemId: item.id, qty: 1 + (Math.random() < 0.2 ? 1 : 0), options });
  }
  return cart;
}

/** Заказ «с кассы»: уже выданный, с временем ожидания из базового замера. */
function makeCounterOrder(venue, now, waitSeconds) {
  const cart = randomCart(venue, 2);
  if (!cart.length) return null;
  const wait = Math.max(120, Math.round(waitSeconds));
  const createdAt = now - wait * 1000;
  const order = orders.create(venue.id, {
    items: cart, channel: 'counter', payment: 'onsite', name: pick(NAMES)
  }, createdAt);
  order.createdAt = new Date(createdAt).toISOString();
  order.status = 'picked_up';
  order.cookStartedAt = new Date(createdAt + 20000).toISOString();
  order.readyAt = new Date(now - 15000).toISOString();
  order.pickedUpAt = new Date(now).toISOString();
  order.paymentStatus = 'paid';
  order.rating = Math.random() < 0.5 ? 4 : 3 + rnd(2);
  return order;
}

/** Заказ с кассы, который кухня готовит прямо сейчас — занимает мощность в текущем слоте. */
function makeLiveCounterOrder(venue, now) {
  const cart = randomCart(venue, 2);
  if (!cart.length) return null;
  const order = orders.create(venue.id, {
    items: cart, channel: 'counter', payment: 'onsite', name: pick(NAMES)
  }, now);
  if (Math.random() < 0.6) orders.setStatus(order, 'cooking', now);
  return order;
}

/** Поток заказов через Express Pick-Up на ближайшие свободные слоты. */
function makeExpressOrders(venue, now, count) {
  const created = [];
  for (let i = 0; i < count; i++) {
    const cart = randomCart(venue);
    if (!cart.length) break;
    const { slots } = capacity.availableSlots(venue, store.orders(), cart, now);
    const free = slots.filter(s => s.available);
    if (!free.length) break;
    // гости чаще берут ближайшее время
    const idx = Math.min(free.length - 1, Math.floor(Math.abs(gauss(0, free.length / 3))));
    try {
      created.push(orders.create(venue.id, {
        items: cart,
        slotStart: free[idx].start,
        payment: Math.random() < 0.7 ? 'online' : 'onsite',
        name: pick(NAMES),
        phone: ''
      }, now));
    } catch (e) {
      if (e.code === 'kitchen_full' || e.code === 'handoff_full') continue;
      throw e;
    }
  }
  return created;
}

/** Завершённый Express-заказ в прошлом — для отчёта за день. */
function makeHistoricalExpress(venue, slotTs, now) {
  const cart = randomCart(venue);
  if (!cart.length) return null;
  const s = venue.settings;
  const createdAt = slotTs - (s.minLeadMinutes + 5 + rnd(25)) * 60000;
  let order;
  try {
    order = orders.create(venue.id, {
      items: cart,
      slotStart: new Date(slotTs).toISOString(),
      payment: Math.random() < 0.7 ? 'online' : 'onsite',
      name: pick(NAMES)
    }, createdAt);
  } catch (e) {
    return null;
  }
  const onTime = Math.random() < 0.93;
  const readyAt = slotTs + (onTime ? -Math.round(Math.random() * 90) : Math.round(60 + Math.random() * 240)) * 1000;
  const arrivedAt = slotTs + Math.round(gauss(0, 70)) * 1000;
  const wait = Math.max(8, Math.round(Math.abs(gauss(46, 26))));
  const pickedUpAt = Math.max(readyAt, arrivedAt) + wait * 1000;

  order.status = 'picked_up';
  order.cookStartedAt = new Date(slotTs - order.workSeconds * 1000).toISOString();
  order.readyAt = new Date(readyAt).toISOString();
  order.arrivedAt = new Date(arrivedAt).toISOString();
  order.pickedUpAt = new Date(Math.min(pickedUpAt, now)).toISOString();
  order.paymentStatus = 'paid';
  order.rating = Math.random() < 0.75 ? 5 : 4;
  return order;
}

function clearVenue(venueId) {
  const db = store.load();
  const before = db.orders.length;
  db.orders = db.orders.filter(o => o.venueId !== venueId);
  store.save({ type: 'demo_reset', venueId });
  return before - db.orders.length;
}

function run(action, venue, now = Date.now()) {
  if (action === 'counter') {
    // живой поток с кассы: гость уже стоит в очереди, кухня занимает мощность прямо сейчас
    const made = [];
    const n = 1 + rnd(3);
    for (let i = 0; i < n; i++) {
      const o = makeLiveCounterOrder(venue, now);
      if (o) made.push(o.code);
    }
    store.save({ type: 'demo_counter', venueId: venue.id });
    return { created: made.length, codes: made, kind: 'counter' };
  }

  if (action === 'rush') {
    const created = makeExpressOrders(venue, now, 6 + rnd(5));
    return { created: created.length, codes: created.map(o => o.code), kind: 'express' };
  }

  if (action === 'reset') {
    const removed = clearVenue(venue.id);
    return { removed };
  }

  if (action === 'history') {
    const made = buildDay(venue, now);
    return { created: made };
  }

  const err = new Error('Неизвестное демо-действие');
  err.code = 'unknown_demo_action';
  throw err;
}

/**
 * Заполняет сегодняшний день до текущего момента: поток с кассы + Express-заказы,
 * чтобы отчёт и сравнение «до/после» были не пустыми.
 */
function buildDay(venue, now = Date.now()) {
  const s = venue.settings;
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const [fh, fm] = s.serviceHours.from.split(':').map(Number);
  const open = day.getTime() + (fh * 60 + fm) * 60000;
  const slotMs = s.slotMinutes * 60000;
  let count = 0;

  for (let ts = open; ts < now - 5 * 60000; ts += slotMs) {
    const d = new Date(ts);
    const minutes = d.getHours() * 60 + d.getMinutes();
    if (minutes < 11 * 60 || minutes >= 15 * 60) continue;
    const peak = minutes >= 12 * 60 && minutes < 14 * 60;

    // Express-заказы на этот слот
    const expressTarget = peak ? (Math.random() < 0.75 ? 2 : 1) : (Math.random() < 0.45 ? 1 : 0);
    for (let i = 0; i < expressTarget; i++) {
      if (makeHistoricalExpress(venue, ts, now)) count++;
    }
    // поток с кассы
    const counterTarget = peak ? (Math.random() < 0.6 ? 2 : 1) : (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < counterTarget; i++) {
      if (makeCounterOrder(venue, ts, gauss(s.baselineWaitSeconds, 280))) count++;
    }
  }
  store.save({ type: 'demo_history', venueId: venue.id });
  return count;
}

module.exports = { run, buildDay, randomCart, clearVenue, makeExpressOrders, makeLiveCounterOrder };
