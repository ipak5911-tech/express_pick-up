'use strict';
/** Бизнес-логика заказа: сборка, резерв слота, статусы, выдача. */
const store = require('./store');
const capacity = require('./capacity');

const STATUSES = ['new', 'cooking', 'ready', 'picked_up', 'cancelled', 'no_show'];
const NEXT = { new: 'cooking', cooking: 'ready', ready: 'picked_up' };

class OrderError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

/** Разворачивает корзину в позиции заказа с ценами и проверкой стоп-листа. */
function buildLines(venue, items) {
  if (!Array.isArray(items) || !items.length) throw new OrderError('empty_cart', 'Корзина пуста');
  const lines = [];
  for (const raw of items) {
    const item = venue.menu.find(i => i.id === raw.itemId);
    if (!item) throw new OrderError('unknown_item', `Позиция не найдена: ${raw.itemId}`);
    if (!item.available) throw new OrderError('stop_list', `В стоп-листе: ${item.name}`, { itemId: item.id });

    const qty = Math.max(1, Math.min(20, parseInt(raw.qty, 10) || 1));
    const chosen = Array.isArray(raw.options) ? raw.options.slice() : [];
    const optionNames = [];
    let delta = 0;

    for (const grp of item.modifiers || []) {
      const picked = (grp.options || []).filter(o => chosen.includes(o.id));
      if (grp.required && picked.length !== 1) {
        throw new OrderError('modifier_required', `Выберите: ${grp.name} (${item.name})`, { itemId: item.id, groupId: grp.id });
      }
      for (const opt of picked) {
        delta += opt.priceDelta || 0;
        optionNames.push(opt.name);
      }
    }
    const known = new Set((item.modifiers || []).flatMap(g => (g.options || []).map(o => o.id)));
    for (const id of chosen) {
      if (!known.has(id)) throw new OrderError('unknown_option', `Неизвестный модификатор: ${id}`);
    }

    lines.push({
      itemId: item.id,
      name: item.name,
      qty,
      options: chosen.filter(id => known.has(id)),
      optionNames,
      unitPrice: item.price + delta,
      total: (item.price + delta) * qty,
      workSeconds: capacity.lineWorkSeconds(item, { qty, options: chosen })
    });
  }
  return lines;
}

function linesToCart(lines) {
  return lines.map(l => ({ itemId: l.itemId, qty: l.qty, options: l.options }));
}

function create(venueId, payload, now = Date.now()) {
  const venue = store.venue(venueId);
  if (!venue) throw new OrderError('unknown_venue', 'Заведение не найдено');

  const lines = buildLines(venue, payload.items);
  const cart = linesToCart(lines);
  const channel = payload.channel === 'counter' ? 'counter' : 'express';

  let slotStart = payload.slotStart;
  let alloc = {};
  let workSeconds = capacity.cartWorkSeconds(venue, cart);
  let cookStart = null;

  if (channel === 'express') {
    const res = capacity.reserve(venue, store.orders(), cart, slotStart, now);
    alloc = res.alloc;
    workSeconds = res.workSeconds;
    cookStart = res.cookStart;
  } else {
    // заказ с кассы: готовится «сейчас», слот = ближайшая граница
    slotStart = new Date(now + workSeconds * 1000).toISOString();
  }

  const payment = payload.payment === 'online' ? 'online' : 'onsite';
  const order = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    token: store.randomToken(),
    code: store.nextCode(venueId),
    venueId,
    channel,
    lines,
    alloc,
    workSeconds,
    cookStart,
    slotStart,
    total: lines.reduce((sum, l) => sum + l.total, 0),
    payment,
    paymentStatus: payment === 'online' ? 'paid' : 'pending',
    guestName: (payload.name || '').toString().slice(0, 60),
    guestPhone: (payload.phone || '').toString().slice(0, 32),
    comment: (payload.comment || '').toString().slice(0, 200),
    status: 'new',
    createdAt: new Date(now).toISOString(),
    cookStartedAt: null,
    readyAt: null,
    arrivedAt: null,
    pickedUpAt: null,
    cancelledAt: null,
    noShowAt: null,
    cancelledBy: null,
    cancelReason: null,
    // оплаченный онлайн заказ, снятый заведением, требует возврата
    refund: payment === 'online' ? 'not_needed' : 'not_applicable',
    rating: null
  };

  store.orders().push(order);
  store.save({ type: 'order_created', venueId, orderId: order.id });
  return order;
}

function setStatus(order, status, now = Date.now()) {
  if (!STATUSES.includes(status)) throw new OrderError('bad_status', 'Неизвестный статус');
  if (order.status === status) return order;
  if (['picked_up', 'cancelled', 'no_show'].includes(order.status)) {
    throw new OrderError('finalized', 'Заказ уже завершён');
  }
  const iso = new Date(now).toISOString();
  order.status = status;
  if (status === 'cooking' && !order.cookStartedAt) order.cookStartedAt = iso;
  if (status === 'ready' && !order.readyAt) order.readyAt = iso;
  if (status === 'picked_up') {
    order.pickedUpAt = iso;
    if (!order.readyAt) order.readyAt = iso;
    if (order.paymentStatus === 'pending') order.paymentStatus = 'paid';
  }
  if (status === 'cancelled') order.cancelledAt = iso;
  if (status === 'no_show') order.noShowAt = iso;
  store.save({ type: 'order_status', venueId: order.venueId, orderId: order.id, status });
  return order;
}

function advance(order, now = Date.now()) {
  const next = NEXT[order.status];
  if (!next) throw new OrderError('finalized', 'Заказ уже завершён');
  return setStatus(order, next, now);
}

function markArrived(order, now = Date.now()) {
  if (order.arrivedAt) return order;
  if (order.status === 'cancelled') throw new OrderError('finalized', 'Заказ отменён');
  order.arrivedAt = new Date(now).toISOString();
  store.save({ type: 'guest_arrived', venueId: order.venueId, orderId: order.id });
  return order;
}

/**
 * Снятие заказа заведением: кончился продукт, сломалось оборудование.
 * Оплаченный онлайн заказ помечается к возврату — деньги не «повисают».
 */
function cancelByVenue(order, reason, now = Date.now()) {
  if (['picked_up', 'cancelled', 'no_show'].includes(order.status)) {
    throw new OrderError('finalized', 'Заказ уже завершён');
  }
  order.cancelledBy = 'venue';
  order.cancelReason = (reason || '').toString().slice(0, 200);
  if (order.payment === 'online' && order.paymentStatus === 'paid') order.refund = 'due';
  setStatus(order, 'cancelled', now);
  return order;
}

/** Гость не пришёл: заказ снимается с табло, но не засчитывается как ожидание. */
function markNoShow(order, now = Date.now()) {
  if (order.status !== 'ready') throw new OrderError('bad_status', 'Неявку отмечают только для готового заказа');
  setStatus(order, 'no_show', now);
  return order;
}

function rate(order, value) {
  const v = Math.max(1, Math.min(5, parseInt(value, 10) || 0));
  order.rating = v;
  store.save({ type: 'order_rated', venueId: order.venueId, orderId: order.id });
  return order;
}

/**
 * Сводка одинаковых позиций по всей очереди.
 *
 * Зачем: экран показывает заказы карточками, и повар не видит, что борщ нужен
 * в четырёх из них сразу. Он готовит их по очереди — а пакетное приготовление
 * одинаковых блюд как раз и есть один из источников роста пропускной
 * способности, который сервис обещает. Без этой сводки обещание остаётся на
 * словах.
 *
 * Сортировка по количеству: сверху то, что выгоднее всего готовить разом.
 * Внутри равного количества — по сроку, чтобы не потерять срочное.
 */
function batches(queueOrders) {
  const map = new Map();
  for (const order of queueOrders) {
    const due = new Date(order.slotStart).getTime();
    for (const line of order.lines || []) {
      if (!map.has(line.itemId)) {
        map.set(line.itemId, {
          itemId: line.itemId, name: line.name,
          qty: 0, orders: 0, workSeconds: 0, dueAt: null
        });
      }
      const b = map.get(line.itemId);
      b.qty += line.qty;
      b.orders += 1;
      b.workSeconds += line.workSeconds || 0;
      if (b.dueAt == null || due < b.dueAt) b.dueAt = due;
    }
  }
  return Array.from(map.values())
    .map(b => ({ ...b, dueAt: b.dueAt == null ? null : new Date(b.dueAt).toISOString() }))
    .sort((a, b) => b.qty - a.qty || new Date(a.dueAt) - new Date(b.dueAt));
}

/** Плановое время начала готовки — по нему сортируется кухонная очередь. */
function cookByTs(order) {
  if (order.cookStart) return new Date(order.cookStart).getTime();
  return new Date(order.slotStart).getTime() - (order.workSeconds || 0) * 1000;
}

/** Публичное представление заказа (для гостя и экранов). */
function publicView(order, venue) {
  return {
    code: order.code,
    token: order.token,
    venue: venue ? { id: venue.id, name: venue.name, address: venue.address, pickupPoint: venue.pickupPoint } : null,
    status: order.status,
    channel: order.channel,
    lines: order.lines.map(l => ({ name: l.name, qty: l.qty, optionNames: l.optionNames, total: l.total })),
    total: order.total,
    payment: order.payment,
    paymentStatus: order.paymentStatus,
    slotStart: order.slotStart,
    cookStart: order.cookStart,
    createdAt: order.createdAt,
    readyAt: order.readyAt,
    arrivedAt: order.arrivedAt,
    pickedUpAt: order.pickedUpAt,
    guestName: order.guestName,
    cancelledBy: order.cancelledBy,
    cancelReason: order.cancelReason,
    refund: order.refund,
    rating: order.rating
  };
}

/**
 * Заказы, которые никто не забрал: через noShowAfterMinutes после слота они
 * уходят с табло выдачи. Без этого они висят вечно и портят метрику ожидания.
 */
function sweepNoShows(now = Date.now()) {
  const changed = [];
  for (const venue of store.venues()) {
    const limit = (venue.settings.noShowAfterMinutes || 20) * 60000;
    const list = store.orders().filter(o => o.venueId === venue.id && o.status === 'ready');
    for (const o of list) {
      const due = new Date(o.readyAt || o.slotStart).getTime() + limit;
      if (now >= due) {
        setStatus(o, 'no_show', now);
        changed.push(o.id);
      }
    }
  }
  return changed;
}

/**
 * Сводка по номеру заказа. Номер короткий, последовательный и называется вслух —
 * то есть публичный по своей природе. Поэтому по нему отдаётся только то, что и
 * так висит на табло выдачи: номер, статус и время. Ни состава заказа, ни имени
 * гостя, ни токена: полный доступ даёт только приватная ссылка или QR.
 */
function publicSummary(order, venue) {
  return {
    code: order.code,
    status: order.status,
    slotStart: order.slotStart,
    readyAt: order.readyAt,
    venue: venue ? { id: venue.id, name: venue.name, pickupPoint: venue.pickupPoint } : null
  };
}

/** Демо-режим: кухня сама двигает статусы по плану. */
function autoKitchenTick(now = Date.now()) {
  const changed = [];
  for (const venue of store.venues()) {
    if (!venue.settings.autoKitchen) continue;
    const list = store.orders().filter(o => o.venueId === venue.id && ['new', 'cooking', 'ready'].includes(o.status));
    for (const o of list) {
      const slotTs = new Date(o.slotStart).getTime();
      if (o.status === 'new' && now >= cookByTs(o)) {
        setStatus(o, 'cooking', now); changed.push(o.id);
      } else if (o.status === 'cooking' && now >= slotTs - 30000) {
        setStatus(o, 'ready', now); changed.push(o.id);
      } else if (o.status === 'ready' && o.arrivedAt && now >= new Date(o.arrivedAt).getTime() + 45000) {
        setStatus(o, 'picked_up', now); changed.push(o.id);
      } else if (o.status === 'ready' && !o.arrivedAt && now >= slotTs + 180000) {
        markArrived(o, now);
      }
    }
  }
  return changed;
}

module.exports = {
  OrderError, STATUSES, create, setStatus, advance, markArrived, rate,
  cancelByVenue, markNoShow, sweepNoShows, publicSummary, batches,
  buildLines, linesToCart, publicView, cookByTs, autoKitchenTick
};
