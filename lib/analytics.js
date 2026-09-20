'use strict';
/** Отчётность пилота: KPI, пиковые часы, опоздания, отмены. */
const capacity = require('./capacity');

const PEAK = { from: 12 * 60, to: 14 * 60 }; // обеденный пик

function minutesOfDay(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function sameDay(iso, dayStart, dayEnd) {
  const t = new Date(iso).getTime();
  return t >= dayStart && t < dayEnd;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Время ожидания гостя на точке: от прихода до получения. */
function handoffWaitSeconds(o) {
  if (!o.pickedUpAt) return null;
  const end = new Date(o.pickedUpAt).getTime();
  const startIso = o.arrivedAt || (o.channel === 'counter' ? o.createdAt : null);
  if (!startIso) return null;
  return Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
}

function isOnTime(o, graceSeconds) {
  if (!o.readyAt || !o.slotStart) return null;
  return new Date(o.readyAt).getTime() <= new Date(o.slotStart).getTime() + graceSeconds * 1000;
}

function report(venue, allOrders, now = Date.now(), dayOffset = 0) {
  const s = venue.settings;
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const dayStart = base.getTime() + dayOffset * 86400000;
  const dayEnd = dayStart + 86400000;

  // День определяется временем выдачи, а не оформления: предзаказ, сделанный
  // накануне, относится к смене, которая его выдаёт, а не к той, что приняла.
  const orders = allOrders.filter(o =>
    o.venueId === venue.id && sameDay(o.slotStart || o.createdAt, dayStart, dayEnd));
  const express = orders.filter(o => o.channel !== 'counter');
  const counter = orders.filter(o => o.channel === 'counter');
  const done = orders.filter(o => o.status === 'picked_up');
  const cancelled = orders.filter(o => o.status === 'cancelled');
  const noShow = orders.filter(o => o.status === 'no_show');
  const cancelledByVenue = cancelled.filter(o => o.cancelledBy === 'venue');
  const refundsDue = orders.filter(o => o.refund === 'due');

  const expressDone = done.filter(o => o.channel !== 'counter');
  const waitExpress = expressDone.map(handoffWaitSeconds).filter(v => v != null);
  const waitCounter = done.filter(o => o.channel === 'counter').map(handoffWaitSeconds).filter(v => v != null);

  const onTimeFlags = express.filter(o => o.readyAt).map(o => isOnTime(o, s.graceSeconds));
  const onTime = onTimeFlags.filter(Boolean).length;

  const peakOrders = orders.filter(o => {
    const m = minutesOfDay(o.slotStart || o.createdAt);
    return m >= PEAK.from && m < PEAK.to && o.status !== 'cancelled';
  });
  const peakExpress = peakOrders.filter(o => o.channel !== 'counter');
  const peakHours = (PEAK.to - PEAK.from) / 60;

  // гистограмма по 5-минутным интервалам (как в замерах недели 1–2)
  const buckets = new Map();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const ts = new Date(o.slotStart || o.createdAt);
    ts.setSeconds(0, 0);
    ts.setMinutes(Math.floor(ts.getMinutes() / 5) * 5);
    const key = ts.toTimeString().slice(0, 5);
    if (!buckets.has(key)) buckets.set(key, { label: key, express: 0, counter: 0 });
    const b = buckets.get(key);
    if (o.channel === 'counter') b.counter++; else b.express++;
  }
  const histogram = Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));

  const lateList = express
    .filter(o => o.readyAt && isOnTime(o, s.graceSeconds) === false)
    .map(o => ({
      code: o.code,
      slot: new Date(o.slotStart).toTimeString().slice(0, 5),
      readyAt: new Date(o.readyAt).toTimeString().slice(0, 5),
      delaySeconds: Math.round((new Date(o.readyAt).getTime() - new Date(o.slotStart).getTime()) / 1000),
      workSeconds: o.workSeconds
    }))
    .sort((a, b) => b.delaySeconds - a.delaySeconds)
    .slice(0, 10);

  // Оценка выдачи — метрика Express-канала: её ставят на странице статуса,
  // которой у гостя с кассы нет. Смешивать каналы здесь значит мерить не то.
  const ratings = express.map(o => o.rating).filter(r => typeof r === 'number');
  const peakThroughput = peakOrders.length / peakHours;

  const demoOrders = orders.filter(o => o.demo);

  return {
    day: new Date(dayStart).toISOString().slice(0, 10),
    // Интерфейс обязан показать, что перед ним симуляция, а не результат пилота
    meta: {
      demoData: demoOrders.length > 0 && demoOrders.length === orders.length,
      containsDemoData: demoOrders.length > 0,
      partiallyDemo: demoOrders.length > 0 && demoOrders.length < orders.length,
      demoOrders: demoOrders.length,
      realOrders: orders.length - demoOrders.length,
      sampleSize: orders.length,
      waitSampleSize: waitExpress.length
    },
    totals: {
      orders: orders.length,
      express: express.length,
      counter: counter.length,
      pickedUp: done.length,
      cancelled: cancelled.length,
      cancelledByVenue: cancelledByVenue.length,
      noShow: noShow.length,
      refundsDue: refundsDue.length,
      cancelRatePct: orders.length ? Math.round((cancelled.length / orders.length) * 100) : 0,
      noShowRatePct: orders.length ? Math.round((noShow.length / orders.length) * 100) : 0,
      revenue: orders.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + o.total, 0)
    },
    kpi: {
      p90WaitSeconds: percentile(waitExpress, 90),
      medianWaitSeconds: percentile(waitExpress, 50),
      p90WaitCounterSeconds: percentile(waitCounter, 90),
      baselineWaitSeconds: s.baselineWaitSeconds,
      onTimePct: onTimeFlags.length ? Math.round((onTime / onTimeFlags.length) * 100) : null,
      expressSharePeakPct: peakOrders.length ? Math.round((peakExpress.length / peakOrders.length) * 100) : 0,
      peakThroughputPerHour: Math.round(peakThroughput * 10) / 10,
      baselineThroughputPerHour: s.baselineOrdersPerHour,
      throughputGainPct: s.baselineOrdersPerHour
        ? Math.round(((peakThroughput - s.baselineOrdersPerHour) / s.baselineOrdersPerHour) * 100)
        : null,
      avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
      ratingsCount: ratings.length
    },
    targets: {
      p90WaitSeconds: 120,
      expressSharePeakPct: 40,
      throughputGainPct: 25,
      onTimePct: 90,
      avgRating: 4.5
    },
    histogram,
    lateList,
    forecast: capacity.forecast(venue, allOrders, now)
  };
}

module.exports = { report, handoffWaitSeconds, isOnTime, percentile };
