'use strict';
/**
 * Движок производственной ёмкости.
 *
 * Идея: слот выдачи — это не «просто время», а обязательство кухни закончить
 * работу к этому моменту. Заказ с объёмом работы W секунд резервирует ёмкость
 * НЕ в слоте выдачи, а в слотах ПЕРЕД ним (окно приготовления), начиная с
 * ближайшего. Слот предлагается гостю только если:
 *   1) до него есть минимальный запас времени (minLeadMinutes);
 *   2) работу удаётся разместить в окне приготовления, не превысив
 *      цифровую долю мощности кухни;
 *   3) не исчерпан лимит выдач в слоте (пропускная способность стойки);
 *   4) он внутри рабочих часов сервиса.
 */

const MIN = 60 * 1000;

function slotMs(settings) { return settings.slotMinutes * MIN; }
function slotIndex(ts, settings) { return Math.floor(ts / slotMs(settings)); }
function slotStart(index, settings) { return index * slotMs(settings); }

/** Ёмкость одного слота в секундах производственной работы, доступных цифровому каналу. */
function slotCapacitySeconds(settings) {
  return Math.round(settings.kitchenThroughputPerMin * settings.slotMinutes * (settings.digitalSharePct / 100));
}

/** Объём работы кухни для позиции корзины, в секундах. */
function lineWorkSeconds(menuItem, line) {
  let extra = 0;
  for (const optId of line.options || []) {
    for (const group of menuItem.modifiers || []) {
      const opt = (group.options || []).find(o => o.id === optId);
      if (opt && opt.prepSeconds) extra += opt.prepSeconds;
    }
  }
  return (menuItem.prepSeconds + extra) * line.qty;
}

/** Суммарный объём работы по корзине. */
function cartWorkSeconds(venue, cart) {
  let total = 0;
  for (const line of cart) {
    const item = venue.menu.find(i => i.id === line.itemId);
    if (!item) continue;
    total += lineWorkSeconds(item, line);
  }
  return total;
}

/** Сколько слотов подряд минимально нужно, чтобы физически произвести объём W. */
function minCookSlots(work, settings) {
  return Math.max(1, Math.ceil(work / slotCapacitySeconds(settings)));
}

/**
 * Текущая занятость кухни по слотам: Map<slotIndex, {work, counterWork, count}>.
 *
 * work        — работа Express-заказов, она расходует зарезервированную цифровую долю;
 * counterWork — работа заказов с кассы, она идёт из оставшейся доли кухни и НЕ
 *               уменьшает доступность слотов. Резерв — это и есть то, что позволяет
 *               держать обещание «готов к назначенному времени» в обеденный пик;
 * count       — число выдач в слоте, лимит пропускной способности стойки.
 */
function buildLedger(orders, settings) {
  const ledger = new Map();
  const touch = idx => {
    if (!ledger.has(idx)) ledger.set(idx, { work: 0, counterWork: 0, count: 0 });
    return ledger.get(idx);
  };
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    if (o.channel === 'counter') {
      const idx = slotIndex(new Date(o.createdAt).getTime(), settings);
      touch(idx).counterWork += o.workSeconds || 0;
      continue;
    }
    for (const [idx, sec] of Object.entries(o.alloc || {})) {
      touch(Number(idx)).work += sec;
    }
    const target = slotIndex(new Date(o.slotStart).getTime(), settings);
    touch(target).count += 1;
  }
  return ledger;
}

/**
 * Пытается разложить работу W по слотам перед слотом выдачи.
 * Возвращает { ok, alloc: {slotIndex: seconds}, cookStartIndex } либо { ok:false, reason }.
 */
function allocate(ledger, targetIndex, work, settings, nowIndex) {
  const cap = slotCapacitySeconds(settings);
  const earliest = Math.max(nowIndex, targetIndex - settings.maxEarlyCookSlots);
  const alloc = {};
  let left = work;
  let cookStartIndex = targetIndex - 1;

  for (let idx = targetIndex - 1; idx >= earliest && left > 0; idx--) {
    const used = (ledger.get(idx) || { work: 0 }).work;
    const free = Math.max(0, cap - used - (alloc[idx] || 0));
    if (free <= 0) continue;
    const take = Math.min(free, left);
    alloc[idx] = (alloc[idx] || 0) + take;
    left -= take;
    cookStartIndex = idx;
  }

  if (left > 0) return { ok: false, reason: 'capacity' };
  return { ok: true, alloc, cookStartIndex };
}

function parseHm(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return { h, m };
}

function withinServiceHours(ts, settings) {
  const d = new Date(ts);
  const from = parseHm(settings.serviceHours.from);
  const to = parseHm(settings.serviceHours.to);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= from.h * 60 + from.m && minutes < to.h * 60 + to.m;
}

/**
 * Список слотов на горизонте с признаком доступности и причиной отказа.
 * cart может быть пустым — тогда считается «пустая» корзина (только лимит выдач).
 */
function availableSlots(venue, allOrders, cart, now = Date.now(), travelMinutes = 0) {
  const settings = venue.settings;
  const ledger = buildLedger(allOrders.filter(o => o.venueId === venue.id), settings);
  const work = cartWorkSeconds(venue, cart);
  const nowIndex = slotIndex(now, settings);
  const cap = slotCapacitySeconds(settings);

  const firstTs = now + settings.minLeadMinutes * MIN;
  let idx = Math.ceil(firstTs / slotMs(settings));
  const lastIdx = slotIndex(now + settings.horizonMinutes * MIN, settings);

  const out = [];
  for (; idx <= lastIdx; idx++) {
    const start = slotStart(idx, settings);
    const entry = ledger.get(idx) || { work: 0, counterWork: 0, count: 0 };
    const row = {
      index: idx,
      start: new Date(start).toISOString(),
      label: new Date(start).toTimeString().slice(0, 5),
      ordersInSlot: entry.count,
      maxOrders: settings.maxOrdersPerSlot,
      loadPct: Math.min(100, Math.round((entry.work / cap) * 100)),
      available: true,
      reason: null
    };

    if (!withinServiceHours(start, settings)) {
      row.available = false;
      row.reason = 'closed';
    } else if (travelMinutes > 0 && start < now + travelMinutes * MIN) {
      // Гость физически не успевает доехать — слот показываем, но с причиной,
      // иначе человек не поймёт, почему ближайшее время недоступно.
      row.available = false;
      row.reason = 'too_far';
    } else if (entry.count >= settings.maxOrdersPerSlot) {
      row.available = false;
      row.reason = 'handoff_full';
    } else if (work > 0) {
      const res = allocate(ledger, idx, work, settings, nowIndex);
      if (!res.ok) {
        row.available = false;
        row.reason = 'kitchen_full';
      } else {
        row.cookStart = new Date(slotStart(res.cookStartIndex, settings)).toISOString();
      }
    }
    out.push(row);
  }
  const needSlots = minCookSlots(work, settings);
  return {
    slots: out,
    travelMinutes,
    workSeconds: work,
    minCookSlots: needSlots,
    capacityPerSlot: cap,
    // заказ физически не производится в окне свежести — нужно дробить или поднимать долю кухни
    tooLarge: work > 0 && needSlots > settings.maxEarlyCookSlots,
    maxWorkSeconds: cap * settings.maxEarlyCookSlots
  };
}

/** Резервирует слот под заказ; возвращает alloc или бросает ошибку. */
function reserve(venue, allOrders, cart, slotStartIso, now = Date.now()) {
  const settings = venue.settings;
  const target = new Date(slotStartIso).getTime();
  if (!Number.isFinite(target)) throw Object.assign(new Error('bad_slot'), { code: 'bad_slot' });

  const idx = slotIndex(target, settings);
  if (slotStart(idx, settings) !== target) throw Object.assign(new Error('bad_slot'), { code: 'bad_slot' });
  if (target < now + settings.minLeadMinutes * MIN - 1000) {
    throw Object.assign(new Error('slot_passed'), { code: 'slot_passed' });
  }
  if (!withinServiceHours(target, settings)) {
    throw Object.assign(new Error('closed'), { code: 'closed' });
  }

  const venueOrders = allOrders.filter(o => o.venueId === venue.id);
  const ledger = buildLedger(venueOrders, settings);
  const entry = ledger.get(idx) || { work: 0, counterWork: 0, count: 0 };
  if (entry.count >= settings.maxOrdersPerSlot) {
    throw Object.assign(new Error('handoff_full'), { code: 'handoff_full' });
  }

  const work = cartWorkSeconds(venue, cart);
  const res = allocate(ledger, idx, work, settings, slotIndex(now, settings));
  if (!res.ok) throw Object.assign(new Error('kitchen_full'), { code: 'kitchen_full' });

  return {
    alloc: res.alloc,
    workSeconds: work,
    cookStart: new Date(slotStart(res.cookStartIndex, settings)).toISOString()
  };
}

/** Прогноз загрузки кухни для дашборда/кухонного экрана. */
function forecast(venue, allOrders, now = Date.now(), slots = 18) {
  const settings = venue.settings;
  const ledger = buildLedger(allOrders.filter(o => o.venueId === venue.id), settings);
  const cap = slotCapacitySeconds(settings);
  const kitchenCap = settings.kitchenThroughputPerMin * settings.slotMinutes;
  const startIdx = slotIndex(now, settings);
  const out = [];
  for (let i = 0; i < slots; i++) {
    const idx = startIdx + i;
    const e = ledger.get(idx) || { work: 0, counterWork: 0, count: 0 };
    out.push({
      label: new Date(slotStart(idx, settings)).toTimeString().slice(0, 5),
      workSeconds: e.work,
      counterSeconds: e.counterWork,
      capacitySeconds: cap,
      kitchenCapacitySeconds: kitchenCap,
      loadPct: Math.round((e.work / cap) * 100),
      totalLoadPct: Math.round(((e.work + e.counterWork) / kitchenCap) * 100),
      handoffs: e.count
    });
  }
  return out;
}

module.exports = {
  MIN, slotMs, slotIndex, slotStart, slotCapacitySeconds,
  cartWorkSeconds, lineWorkSeconds, minCookSlots,
  buildLedger, allocate, availableSlots, reserve, forecast, withinServiceHours
};
