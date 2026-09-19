'use strict';
/** Файловое хранилище + шина событий. Без внешних зависимостей. */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Путь к базе переопределяется переменной окружения: тесты работают на своей
// копии и не затирают демонстрационные данные заведения.
const DB_FILE = process.env.EPU_DB_FILE
  ? path.resolve(process.env.EPU_DB_FILE)
  : path.join(__dirname, '..', 'data', 'db.json');
const DATA_DIR = path.dirname(DB_FILE);

const bus = new EventEmitter();
bus.setMaxListeners(200);

let db = null;
let writeTimer = null;

function emptyDb() {
  return { venues: [], orders: [], counters: {}, meta: { createdAt: new Date().toISOString() } };
}

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.venues) db = emptyDb();
  } catch (e) {
    db = emptyDb();
  }
  return db;
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error('Не удалось сохранить БД:', e.message);
    }
  }, 120);
}

function save(event) {
  persist();
  if (event) bus.emit('change', event);
}

function replace(next) {
  db = next;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить БД:', e.message);
  }
  bus.emit('change', { type: 'reset' });
}

const venues = () => load().venues;
const orders = () => load().orders;
const venue = id => venues().find(v => v.id === id) || null;
const menuItem = (v, itemId) => v.menu.find(i => i.id === itemId) || null;
const orderById = id => orders().find(o => o.id === id) || null;
const orderByToken = token => orders().find(o => o.token === token) || null;

function orderByCode(venueId, code) {
  const norm = String(code).trim().toUpperCase();
  return orders().find(o => o.venueId === venueId && o.code.toUpperCase() === norm) || null;
}

function nextCode(venueId) {
  const d = load();
  const key = `${venueId}:${new Date().toISOString().slice(0, 10)}`;
  d.counters[key] = (d.counters[key] || 100) + 1;
  return String(d.counters[key]);
}

function randomToken() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

module.exports = {
  bus, load, save, replace, emptyDb,
  venues, venue, menuItem, orders, orderById, orderByToken, orderByCode,
  nextCode, randomToken, DB_FILE
};
