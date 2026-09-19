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
for (const venue of store.venues()) {
  demo.clearVenue(venue.id);
  total += demo.buildDay(venue, now);
  const live = demo.makeExpressOrders(venue, now, 7);
  total += live.length;
  console.log(`  ${venue.name}: история + ${live.length} активных заказов`);
}
console.log(`\nГотово. Всего заказов в демо-базе: ${total}`);
console.log(`Файл БД: ${store.DB_FILE}`);
