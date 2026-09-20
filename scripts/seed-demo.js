#!/usr/bin/env node
'use strict';
/** Готовит демо-данные: меню + день замеров + живая очередь на ближайшие слоты. */
const store = require('../lib/store');
const seed = require('../lib/seed');
const demo = require('../lib/demo');

const fresh = process.argv.includes('--fresh');
const db = store.load();

if (fresh || !db.venues.length) {
  store.replace(Object.assign(store.emptyDb(), { venues: seed.seedVenues() }));
}

const now = Date.now();
let total = 0;
// Неделя истории: калибровка производственных параметров набирает статистику
// за пилот, а не за один обед, поэтому демо должно это отражать.
const HISTORY_DAYS = 7;

for (const venue of store.venues()) {
  demo.clearVenue(venue.id);
  for (let back = HISTORY_DAYS - 1; back >= 0; back--) {
    total += demo.buildDay(venue, now, -back);
  }
  const live = demo.makeExpressOrders(venue, now, 7);
  total += live.length;
  console.log(`  ${venue.name}: ${HISTORY_DAYS} дней истории + ${live.length} активных`);
}
console.log(`\nГотово. Всего заказов в демо-базе: ${total}`);
console.log(`Файл БД: ${store.DB_FILE}`);
