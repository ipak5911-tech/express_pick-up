'use strict';
/**
 * Калибровка производственных параметров по фактическим замерам.
 *
 * Зачем: `prepSeconds` и `kitchenThroughputPerMin` задаются человеком на глаз,
 * и это главное допущение всей модели ёмкости. Кухонный экран уже фиксирует,
 * когда заказ начали готовить и когда он стал готов, — значит систему можно
 * научить проверять собственные параметры на реальных данных.
 *
 * Здесь нет машинного обучения и обращений к внешним сервисам: только
 * устойчивая статистика по измеренным отметкам времени.
 */

const PEAK = { from: 12 * 60, to: 14 * 60 };

/** Минимум наблюдений, ниже которого предлагать новое значение нечестно. */
const MIN_SAMPLES = 5;

/** Расхождение меньше этого считаем совпадением, а не поводом менять настройку. */
const TOLERANCE_PCT = 15;

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Отбрасывает выбросы по медианному абсолютному отклонению.
 *
 * Среднее здесь непригодно: если повар забыл нажать «готово» и заказ висел
 * сорок минут, одно такое наблюдение утащит оценку в любую сторону.
 */
function withoutOutliers(values) {
  if (values.length < 4) return values;
  const med = median(values);
  const mad = median(values.map(v => Math.abs(v - med)));
  if (!mad) return values;
  return values.filter(v => Math.abs(v - med) <= 3 * mad);
}

/** Сколько секунд добавили выбранные модификаторы — эту часть считаем известной. */
function modifierSeconds(venue, line) {
  const item = venue.menu.find(i => i.id === line.itemId);
  if (!item) return 0;
  let extra = 0;
  for (const optId of line.options || []) {
    for (const group of item.modifiers || []) {
      const opt = (group.options || []).find(o => o.id === optId);
      if (opt && opt.prepSeconds) extra += opt.prepSeconds;
    }
  }
  return extra;
}

/**
 * Предложения по времени приготовления позиций меню.
 *
 * Используются ТОЛЬКО заказы из одной позиции в одном экземпляре. Причина
 * принципиальная: внутри многопозиционного заказа блюда готовятся параллельно,
 * поэтому настенное время такого заказа не равно сумме prepSeconds его
 * позиций, и делить его между блюдами было бы выдумкой.
 */
function itemSuggestions(venue, allOrders) {
  const samplesByItem = new Map();

  for (const o of allOrders) {
    if (o.venueId !== venue.id) continue;
    if (!o.cookStartedAt || !o.readyAt) continue;
    if (!Array.isArray(o.lines) || o.lines.length !== 1) continue;
    const line = o.lines[0];
    if (line.qty !== 1) continue;

    const wall = (new Date(o.readyAt).getTime() - new Date(o.cookStartedAt).getTime()) / 1000;
    if (!Number.isFinite(wall) || wall <= 0) continue;

    const pure = wall - modifierSeconds(venue, line);
    if (pure <= 0) continue;

    if (!samplesByItem.has(line.itemId)) samplesByItem.set(line.itemId, []);
    samplesByItem.get(line.itemId).push(pure);
  }

  return venue.menu.map(item => {
    const raw = samplesByItem.get(item.id) || [];
    const clean = withoutOutliers(raw);
    const observed = clean.length ? Math.round(median(clean)) : null;
    const enough = clean.length >= MIN_SAMPLES;
    const deltaPct = observed && item.prepSeconds
      ? Math.round(((observed - item.prepSeconds) / item.prepSeconds) * 100)
      : null;

    let verdict = 'no_data';
    if (!enough) verdict = 'few_samples';
    else if (Math.abs(deltaPct) <= TOLERANCE_PCT) verdict = 'matches';
    else verdict = deltaPct > 0 ? 'underestimated' : 'overestimated';

    return {
      itemId: item.id,
      name: item.name,
      category: item.category,
      current: item.prepSeconds,
      observed,
      suggested: enough ? observed : null,
      samples: clean.length,
      discarded: raw.length - clean.length,
      deltaPct,
      verdict
    };
  }).sort((a, b) => {
    const rank = v => ({ underestimated: 0, overestimated: 0, matches: 1, few_samples: 2, no_data: 3 }[v.verdict]);
    const d = rank(a) - rank(b);
    return d !== 0 ? d : Math.abs(b.deltaPct || 0) - Math.abs(a.deltaPct || 0);
  });
}

/**
 * Проверка производительности кухни.
 *
 * Отдельно от позиций: R — это пропускная способность всей кухни, и измеряется
 * она агрегатом за загруженный период, а не по отдельному заказу.
 *
 * Важная оговорка: если кухня в пик простаивала, наблюдаемая величина выйдет
 * ниже заявленной, и это не значит, что настройка завышена. Поэтому вывод
 * делается в паре с долей «готовы вовремя».
 */
function throughputReport(venue, allOrders, now = Date.now()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const from = day.getTime() + PEAK.from * 60000;
  // Делить на полные два часа, когда прошло тридцать минут, — значит занизить
  // производительность вчетверо и объявить работающую кухню простаивающей.
  const to = Math.min(day.getTime() + PEAK.to * 60000, now);
  const minutes = Math.max(0, (to - from) / 60000);
  const MIN_WINDOW_MINUTES = 20;

  if (minutes < MIN_WINDOW_MINUTES) {
    return {
      windowLabel: '12:00–14:00',
      elapsedMinutes: Math.round(minutes),
      orders: 0, workSeconds: 0, observed: 0,
      configured: venue.settings.kitchenThroughputPerMin,
      onTimePct: null,
      verdict: 'too_early'
    };
  }

  const inPeak = allOrders.filter(o => {
    if (o.venueId !== venue.id || !o.readyAt) return false;
    const ts = new Date(o.readyAt).getTime();
    return ts >= from && ts < to;
  });

  const workSeconds = inPeak.reduce((sum, o) => sum + (o.workSeconds || 0), 0);
  const observed = minutes ? Math.round(workSeconds / minutes) : 0;
  const configured = venue.settings.kitchenThroughputPerMin;

  const timed = inPeak.filter(o => o.slotStart && o.channel !== 'counter');
  const onTime = timed.filter(o =>
    new Date(o.readyAt).getTime() <= new Date(o.slotStart).getTime() + venue.settings.graceSeconds * 1000);
  const onTimePct = timed.length ? Math.round((onTime.length / timed.length) * 100) : null;

  let verdict = 'no_data';
  if (inPeak.length >= MIN_SAMPLES) {
    if (onTimePct != null && onTimePct < 90) verdict = 'kitchen_behind';
    else if (observed > configured) verdict = 'underconfigured';
    else if (observed >= configured * 0.6) verdict = 'matches';
    else verdict = 'idle';
  }

  return {
    windowLabel: '12:00–14:00',
    elapsedMinutes: Math.round(minutes),
    orders: inPeak.length,
    workSeconds,
    observed,
    configured,
    onTimePct,
    verdict
  };
}

function report(venue, allOrders, now = Date.now()) {
  return {
    minSamples: MIN_SAMPLES,
    tolerancePct: TOLERANCE_PCT,
    items: itemSuggestions(venue, allOrders),
    throughput: throughputReport(venue, allOrders, now)
  };
}

module.exports = { report, itemSuggestions, throughputReport, median, withoutOutliers, MIN_SAMPLES };
