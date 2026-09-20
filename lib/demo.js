'use strict';
/** Демо-инструменты: имитация потока с кассы, наплыва цифровых заказов, сброса дня. */
const store = require('./store');
const capacity = require('./capacity');
const orders = require('./orders');

const NAMES = ['Анна', 'Марат', 'Ирина', 'Дмитрий', 'Айгуль', 'Пётр', 'Камила', 'Сергей', 'Ольга', 'Тимур', 'Юлия', 'Никита'];

/**
 * Демо-данные имитируют то, что происходит в настоящей кухне: фактическое
 * время готовки отличается от планового, а у части позиций плановое значение
 * просто выставлено неверно — человек вписал его на глаз. Именно это и должна
 * находить калибровка, поэтому в демо заложено осознанное расхождение.
 */
const DEMO_PREP_BIAS = {
  'c-chicken': 1.35,    // гриль недооценён: на деле дольше
  'c-borsch': 0.65,     // суп переоценён: наливается быстрее
  'k-sandwich': 1.25,
  's-shawarma': 1.20,
  'p-margherita': 1.15
};

/**
 * Детерминированный генератор для показа жюри.
 *
 * Обычное демо использует Math.random, и цифры на экране каждый раз другие.
 * Для защиты это недопустимо: репетиция и выступление должны давать одни и те
 * же KPI, иначе нельзя ни отрепетировать речь, ни доверять показанному.
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

let random = Math.random;

function rnd(n) { return Math.floor(random() * n); }
function pick(arr) { return arr[rnd(arr.length)]; }
function gauss(mean, sd) {
  const u = 1 - random(), v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Фактическое время готовки заказа: плановое с перекосом и разбросом. */
function actualCookSeconds(order) {
  let seconds = 0;
  for (const line of order.lines) {
    seconds += (line.workSeconds || 0) * (DEMO_PREP_BIAS[line.itemId] || 1);
  }
  return Math.max(15, Math.round(seconds * Math.max(0.6, Math.min(1.6, gauss(1, 0.12)))));
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
      else if (grp.options.length && random() < 0.3) options.push(pick(grp.options).id);
    }
    cart.push({ itemId: item.id, qty: 1 + (random() < 0.2 ? 1 : 0), options });
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
  const counterReady = now - 15000;
  order.cookStartedAt = new Date(counterReady - actualCookSeconds(order) * 1000).toISOString();
  order.readyAt = new Date(counterReady).toISOString();
  order.pickedUpAt = new Date(now).toISOString();
  order.paymentStatus = 'paid';
  // Оценку ставят на странице статуса, а её видит только Express-гость.
  // Заказ с кассы оценить негде, поэтому рейтинга у него быть не может.
  return order;
}

/** Заказ с кассы, который кухня готовит прямо сейчас — занимает мощность в текущем слоте. */
function makeLiveCounterOrder(venue, now) {
  const cart = randomCart(venue, 2);
  if (!cart.length) return null;
  const order = orders.create(venue.id, {
    items: cart, channel: 'counter', payment: 'onsite', name: pick(NAMES)
  }, now);
  if (random() < 0.6) orders.setStatus(order, 'cooking', now);
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
    // Гости берут ближайшее доступное время, и для показа это принципиально:
    // закрываться должны ближние слоты, иначе жюри не увидит, как система
    // перестаёт продавать время на ближайшие минуты.
    const idx = Math.min(free.length - 1, Math.floor(Math.abs(gauss(0, 1.2))));
    try {
      created.push(orders.create(venue.id, {
        items: cart,
        slotStart: free[idx].start,
        payment: random() < 0.7 ? 'online' : 'onsite',
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
      payment: random() < 0.7 ? 'online' : 'onsite',
      name: pick(NAMES)
    }, createdAt);
  } catch (e) {
    return null;
  }
  const onTime = random() < 0.93;
  const readyAt = slotTs + (onTime ? -Math.round(random() * 90) : Math.round(60 + random() * 240)) * 1000;
  const arrivedAt = slotTs + Math.round(gauss(0, 70)) * 1000;
  const wait = Math.max(8, Math.round(Math.abs(gauss(46, 26))));
  const pickedUpAt = Math.max(readyAt, arrivedAt) + wait * 1000;

  order.status = 'picked_up';
  order.cookStartedAt = new Date(readyAt - actualCookSeconds(order) * 1000).toISOString();
  order.readyAt = new Date(readyAt).toISOString();
  order.arrivedAt = new Date(arrivedAt).toISOString();
  order.pickedUpAt = new Date(Math.min(pickedUpAt, now)).toISOString();
  order.paymentStatus = 'paid';
  order.rating = random() < 0.75 ? 5 : 4;
  return order;
}

/**
 * Подготовка демонстрации для жюри.
 *
 * Отличие от обычного демо принципиальное: данные строятся из фиксированного
 * зерна, поэтому репетиция и выступление дают одни и те же цифры. Показывать
 * жюри KPI, которые меняются при каждом запуске, нельзя — ни отрепетировать
 * речь, ни доверять показанному.
 *
 * Все созданные записи помечаются `demo: true`, а отчёт сообщает об этом
 * интерфейсу: выдавать симуляцию за результат пилота недопустимо.
 */
function buildShowcase(venue, now = Date.now(), seed = 20260920) {
  const previous = random;
  random = seededRandom(seed);

  try {
    clearVenue(venue.id);

    const s = venue.settings;
    venue.settings.autoKitchen = false;   // статусы двигает человек, а не автопилот

    // Демонстрационные часы работы на сутки. Без этого показ вечером упирался
    // бы в закрытое заведение: слотов нет, заказать нечего, и весь сценарий
    // разваливается на сцене. Исходные часы сохраняются, чтобы вернуть их.
    if (!venue.settings.realServiceHours) {
      venue.settings.realServiceHours = Object.assign({}, s.serviceHours);
    }
    venue.settings.serviceHours = { from: '00:00', to: '23:59' };

    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const slotMs = s.slotMinutes * 60000;
    const peakFrom = day.getTime() + 12 * 3600000;
    const peakTo = day.getTime() + 14 * 3600000;

    // Сколько выдач нужно в пике, чтобы рост против базы превысил цель
    // Запас над целью нужен: часть заказов не проходит по ёмкости, а рост
    // ровно в 25 % на сцене выглядит как подгонка под критерий.
    const targetPerHour = Math.ceil(s.baselineOrdersPerHour * 1.45);
    const targetPeakOrders = targetPerHour * 2;
    const expressShare = 0.5;             // с запасом над целью в 40 %
    const targetExpress = Math.round(targetPeakOrders * expressShare);
    const targetCounter = targetPeakOrders - targetExpress;

    const created = { express: 0, counter: 0, live: 0 };

    // Заказы с кассы: ожидание около базового замера — это точка отсчёта
    for (let i = 0; i < targetCounter; i++) {
      const ts = peakFrom + Math.floor((i + 0.5) * ((peakTo - peakFrom) / targetCounter));
      if (makeCounterOrder(venue, ts, gauss(s.baselineWaitSeconds, 180))) created.counter++;
    }

    // Express-заказы: готовы заранее, ожидание на точке — десятки секунд
    for (let i = 0; i < targetExpress; i++) {
      const raw = peakFrom + Math.floor((i + 0.5) * ((peakTo - peakFrom) / targetExpress));
      const slotTs = Math.floor(raw / slotMs) * slotMs;
      const order = makeShowcaseExpress(venue, slotTs, now, i);
      if (order) created.express++;
    }

    // Несколько активных заказов, чтобы ближайшие слоты не были пустыми
    created.live = makeExpressOrders(venue, now, 5).length;

    // Мощность для заказа жюри обязана остаться: если ближайшие слоты выбраны
    // полностью, гость на сцене не сможет ничего заказать.
    const probe = probeCart(venue);
    let free = snapshotSlots(venue, probe, now).available.length;
    while (free < 3 && created.live > 0) {
      const last = store.orders().filter(o => o.venueId === venue.id && o.status === 'new').pop();
      if (!last) break;
      const db = store.load();
      db.orders = db.orders.filter(o => o !== last);
      created.live--;
      free = snapshotSlots(venue, probe, now).available.length;
    }
    created.freeSlots = free;

    // Помечаем всё созданное: отчёт обязан отличать симуляцию от пилота
    for (const o of store.orders()) {
      if (o.venueId === venue.id) o.demo = true;
    }

    store.save({ type: 'demo_showcase', venueId: venue.id });
    return created;
  } finally {
    random = previous;
  }
}

/**
 * Express-заказ для показа: готов к слоту, гость подошёл почти вовремя,
 * выдача занимает секунды. Каждый двадцатый опаздывает — иначе «100 % вовремя»
 * выглядит нарисованным, да и так оно и есть в жизни.
 */
function makeShowcaseExpress(venue, slotTs, now, index) {
  const cart = randomCart(venue, 2);
  if (!cart.length) return null;

  const s = venue.settings;
  const createdAt = slotTs - (s.minLeadMinutes + 8 + rnd(20)) * 60000;
  let order;
  try {
    order = orders.create(venue.id, {
      items: cart,
      slotStart: new Date(slotTs).toISOString(),
      payment: random() < 0.75 ? 'online' : 'onsite',
      name: pick(NAMES)
    }, createdAt);
  } catch (e) {
    return null;
  }

  const late = index % 20 === 19;
  const readyAt = slotTs + (late ? 90 + rnd(60) : -(20 + rnd(70))) * 1000;
  const arrivedAt = slotTs + Math.round(gauss(15, 45)) * 1000;
  const handover = 25 + Math.round(Math.abs(gauss(20, 14)));   // выдача — десятки секунд
  const pickedUpAt = Math.max(readyAt, arrivedAt) + handover * 1000;

  order.status = 'picked_up';
  order.cookStartedAt = new Date(readyAt - actualCookSeconds(order) * 1000).toISOString();
  order.readyAt = new Date(readyAt).toISOString();
  order.arrivedAt = new Date(arrivedAt).toISOString();
  // Без обрезки по текущему моменту: она давала заказам из ещё не наступившей
  // части пика нулевое ожидание и ломала медиану. Демонстрационный день
  // моделируется целиком, и отчёт честно помечен как симуляция.
  order.pickedUpAt = new Date(pickedUpAt).toISOString();
  order.paymentStatus = 'paid';
  order.rating = random() < 0.8 ? 5 : 4;
  return order;
}

/** Небольшая типовая корзина — эталон, по которому меряется доступность. */
function probeCart(venue) {
  const pool = venue.menu.filter(i => i.available);
  if (!pool.length) return [];
  const item = pool.slice().sort((a, b) => a.prepSeconds - b.prepSeconds)[Math.floor(pool.length / 2)];
  const options = [];
  for (const grp of item.modifiers || []) {
    if (grp.required && grp.options.length) options.push(grp.options[0].id);
  }
  return [{ itemId: item.id, qty: 1, options }];
}

/** Какие времена сейчас продаются и почему закрыты остальные. */
function snapshotSlots(venue, cart, now) {
  const { slots } = capacity.availableSlots(venue, store.orders(), cart, now);
  const visible = slots.filter(s => s.reason !== 'closed');
  const reasons = {};
  for (const s of visible) if (!s.available) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  return { available: visible.filter(s => s.available).map(s => s.label), reasons };
}

function clearVenue(venueId) {
  const db = store.load();
  const before = db.orders.length;
  db.orders = db.orders.filter(o => o.venueId !== venueId);
  store.save({ type: 'demo_reset', venueId });
  return before - db.orders.length;
}

function run(action, venue, now = Date.now(), options = {}) {
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
    // Снимок доступности до и после наплыва: смысл демонстрации не в числе
    // созданных заказов, а в том, какие именно времена перестали продаваться.
    const probe = probeCart(venue);
    const before = snapshotSlots(venue, probe, now);
    const created = makeExpressOrders(venue, now, 6 + rnd(5));
    const after = snapshotSlots(venue, probe, now);

    const closed = before.available.filter(label => !after.available.includes(label));
    // Ноль принятых заказов — не сбой, а самый показательный исход: кухня уже
    // занята, и система отказывается продавать время, которое не выполнит.
    return {
      saturated: created.length === 0 && before.available.length === after.available.length,
      created: created.length,
      codes: created.map(o => o.code),
      kind: 'express',
      closedSlots: closed,
      availableBefore: before.available.length,
      availableAfter: after.available.length,
      nextGuaranteed: after.available[0] || null,
      reasons: after.reasons
    };
  }

  if (action === 'reset') {
    const removed = clearVenue(venue.id);
    return { removed };
  }

  if (action === 'showcase') {
    const created = buildShowcase(venue, now, Number(options.seed) || undefined);
    return { created: created.express + created.counter + created.live, breakdown: created, kind: 'showcase' };
  }

  if (action === 'stress') {
    // В отличие от случайного наплыва, здесь заказы добавляются ровно до тех
    // пор, пока не закроется ближайший доступный слот. На сцене результат
    // должен быть гарантированным, а не «как повезёт».
    const probe = probeCart(venue);
    const before = snapshotSlots(venue, probe, now);
    const target = before.available[0] || null;
    const codes = [];
    const LIMIT = 12;

    for (let i = 0; i < LIMIT && target; i++) {
      const snapshot = snapshotSlots(venue, probe, now);
      if (!snapshot.available.includes(target)) break;
      const cart = randomCart(venue, 2);
      const slots = capacity.availableSlots(venue, store.orders(), cart, now).slots;
      const slot = slots.find(x => x.available && x.label === target) ||
                   slots.find(x => x.available);
      if (!slot) break;
      try {
        codes.push(orders.create(venue.id, {
          items: cart, slotStart: slot.start, payment: 'online', name: pick(NAMES)
        }, now).code);
      } catch (e) {
        break;
      }
    }

    const after = snapshotSlots(venue, probe, now);
    store.save({ type: 'demo_stress', venueId: venue.id });
    return {
      kind: 'stress',
      created: codes.length,
      codes,
      targetSlot: target,
      closedSlots: before.available.filter(l => !after.available.includes(l)),
      nextAvailable: after.available[0] || null,
      availableBefore: before.available.length,
      availableAfter: after.available.length,
      saturated: after.available.length === 0
    };
  }

  if (action === 'history') {
    // Калибровка набирает статистику за пилот, а не за один обед, поэтому
    // историю можно запросить сразу за несколько дней.
    const days = Math.max(1, Math.min(14, Number(options.days) || 1));
    let made = 0;
    for (let back = days - 1; back >= 0; back--) made += buildDay(venue, now, -back);
    return { created: made, days };
  }

  const err = new Error('Неизвестное демо-действие');
  err.code = 'unknown_demo_action';
  throw err;
}

/**
 * Заполняет сегодняшний день до текущего момента: поток с кассы + Express-заказы,
 * чтобы отчёт и сравнение «до/после» были не пустыми.
 */
function buildDay(venue, now = Date.now(), dayOffset = 0) {
  const s = venue.settings;
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + dayOffset);
  const [fh, fm] = s.serviceHours.from.split(':').map(Number);
  const open = day.getTime() + (fh * 60 + fm) * 60000;
  const slotMs = s.slotMinutes * 60000;
  let count = 0;

  const until = dayOffset < 0 ? day.getTime() + 23 * 3600000 : now - 5 * 60000;
  for (let ts = open; ts < until; ts += slotMs) {
    const d = new Date(ts);
    const minutes = d.getHours() * 60 + d.getMinutes();
    if (minutes < 11 * 60 || minutes >= 15 * 60) continue;
    const peak = minutes >= 12 * 60 && minutes < 14 * 60;

    // Express-заказы на этот слот
    const expressTarget = peak ? (random() < 0.6 ? 2 : 1) : (random() < 0.5 ? 1 : 0);
    for (let i = 0; i < expressTarget; i++) {
      if (makeHistoricalExpress(venue, ts, now)) count++;
    }
    // поток с кассы
    const counterTarget = peak ? (random() < 0.6 ? 2 : 1) : (random() < 0.5 ? 1 : 0);
    for (let i = 0; i < counterTarget; i++) {
      if (makeCounterOrder(venue, ts, gauss(s.baselineWaitSeconds, 280))) count++;
    }
  }
  store.save({ type: 'demo_history', venueId: venue.id });
  return count;
}

module.exports = { run, buildDay, buildShowcase, randomCart, clearVenue, makeExpressOrders, makeLiveCounterOrder };
