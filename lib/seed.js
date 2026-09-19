'use strict';
/** Стартовые данные пилота: 3 заведения с меню, модификаторами и настройками ёмкости. */

const DEFAULT_SETTINGS = {
  slotMinutes: 5,
  horizonMinutes: 90,
  minLeadMinutes: 10,
  kitchenThroughputPerMin: 180,   // секунд производственной работы в минуту (≈3 параллельные станции)
  digitalSharePct: 30,            // доля мощности кухни, отданная Express Pick-Up (пилот: 20–30%)
  maxOrdersPerSlot: 4,            // пропускная способность стойки выдачи за слот
  maxEarlyCookSlots: 4,           // блюдо не начинают готовить раньше чем за 20 минут до выдачи
  graceSeconds: 60,               // допуск «готов вовремя»
  noShowAfterMinutes: 20,         // через сколько минут незабранный заказ уходит с табло
  serviceHours: { from: '08:00', to: '19:00' },
  autoKitchen: false,             // демо-режим: кухня двигает статусы сама
  baselineWaitSeconds: 1200,      // замер «до»: 20 минут от входа до получения
  baselineOrdersPerHour: 24       // замер «до»: выдач в час в обеденный пик
};

function group(id, name, required, options) {
  return { id, name, required, options };
}

function venueTemplate(id, name, kind, address, pickupPoint, location, menu, overrides = {}) {
  return {
    id, name, kind, address, pickupPoint, location,
    settings: Object.assign({}, DEFAULT_SETTINGS, overrides),
    menu
  };
}

const sizeGroup = group('size', 'Порция', true, [
  { id: 'size-s', name: 'Стандарт', priceDelta: 0, prepSeconds: 0 },
  { id: 'size-l', name: 'Большая', priceDelta: 400, prepSeconds: 20 }
]);

const sauceGroup = group('sauce', 'Соус', false, [
  { id: 'sauce-none', name: 'Без соуса', priceDelta: 0, prepSeconds: 0 },
  { id: 'sauce-cheese', name: 'Сырный', priceDelta: 250, prepSeconds: 5 },
  { id: 'sauce-spicy', name: 'Острый', priceDelta: 250, prepSeconds: 5 }
]);

const canteenMenu = [
  { id: 'c-soup', name: 'Борщ с говядиной', category: 'Супы', desc: 'Порция 300 мл, сметана отдельно', price: 1400, prepSeconds: 45, available: true, modifiers: [group('extra', 'Дополнительно', false, [{ id: 'sour-cream', name: 'Сметана', priceDelta: 150, prepSeconds: 5 }, { id: 'bread', name: 'Хлеб', priceDelta: 100, prepSeconds: 3 }])] },
  { id: 'c-chicken', name: 'Куриное филе на гриле', category: 'Горячее', desc: 'Готовится под заказ', price: 2200, prepSeconds: 260, available: true, modifiers: [sauceGroup] },
  { id: 'c-cutlet', name: 'Котлета домашняя', category: 'Горячее', desc: 'С пылу с жару', price: 1300, prepSeconds: 90, available: true, modifiers: [sauceGroup] },
  { id: 'c-fish', name: 'Треска запечённая', category: 'Горячее', desc: 'С лимоном', price: 2600, prepSeconds: 300, available: true, modifiers: [] },
  { id: 'c-buckwheat', name: 'Гречка с овощами', category: 'Гарниры', desc: 'Готово на линии', price: 600, prepSeconds: 25, available: true, modifiers: [sizeGroup] },
  { id: 'c-potato', name: 'Картофельное пюре', category: 'Гарниры', desc: 'Готово на линии', price: 650, prepSeconds: 25, available: true, modifiers: [sizeGroup] },
  { id: 'c-salad', name: 'Салат «Витаминный»', category: 'Салаты', desc: 'Капуста, морковь, масло', price: 550, prepSeconds: 40, available: true, modifiers: [] },
  { id: 'c-olivier', name: 'Оливье', category: 'Салаты', desc: 'Классический', price: 800, prepSeconds: 30, available: true, modifiers: [] },
  { id: 'c-compote', name: 'Компот', category: 'Напитки', desc: '250 мл', price: 350, prepSeconds: 10, available: true, modifiers: [] },
  { id: 'c-tea', name: 'Чай', category: 'Напитки', desc: 'Чёрный или зелёный', price: 300, prepSeconds: 10, available: true, modifiers: [group('tea', 'Вид', true, [{ id: 'tea-black', name: 'Чёрный', priceDelta: 0, prepSeconds: 0 }, { id: 'tea-green', name: 'Зелёный', priceDelta: 0, prepSeconds: 0 }])] }
];

const cafeMenu = [
  { id: 'k-latte', name: 'Латте', category: 'Кофе', desc: '300 мл', price: 1500, prepSeconds: 70, available: true, modifiers: [group('milk', 'Молоко', true, [{ id: 'milk-cow', name: 'Обычное', priceDelta: 0, prepSeconds: 0 }, { id: 'milk-oat', name: 'Овсяное', priceDelta: 400, prepSeconds: 0 }, { id: 'milk-lactfree', name: 'Безлактозное', priceDelta: 400, prepSeconds: 0 }])] },
  { id: 'k-americano', name: 'Американо', category: 'Кофе', desc: '300 мл', price: 1100, prepSeconds: 45, available: true, modifiers: [] },
  { id: 'k-sandwich', name: 'Сэндвич с индейкой', category: 'Еда', desc: 'На гриле', price: 2200, prepSeconds: 150, available: true, modifiers: [group('heat', 'Подача', true, [{ id: 'heat-hot', name: 'Разогреть', priceDelta: 0, prepSeconds: 60 }, { id: 'heat-cold', name: 'Холодный', priceDelta: 0, prepSeconds: 0 }])] },
  { id: 'k-bowl', name: 'Боул с курицей', category: 'Еда', desc: 'Киноа, овощи, соус', price: 2900, prepSeconds: 200, available: true, modifiers: [sauceGroup] },
  { id: 'k-soup', name: 'Крем-суп тыквенный', category: 'Еда', desc: '300 мл', price: 1700, prepSeconds: 60, available: true, modifiers: [] },
  { id: 'k-croissant', name: 'Круассан', category: 'Выпечка', desc: 'Классический', price: 900, prepSeconds: 20, available: true, modifiers: [group('fill', 'Начинка', false, [{ id: 'fill-choco', name: 'Шоколад', priceDelta: 350, prepSeconds: 10 }, { id: 'fill-ham', name: 'Ветчина и сыр', priceDelta: 600, prepSeconds: 45 }])] },
  { id: 'k-cheesecake', name: 'Чизкейк', category: 'Выпечка', desc: 'Нью-Йорк', price: 1800, prepSeconds: 20, available: true, modifiers: [] },
  { id: 'k-lemonade', name: 'Лимонад', category: 'Напитки', desc: '400 мл', price: 1300, prepSeconds: 40, available: true, modifiers: [] }
];

const foodcourtMenu = [
  { id: 'w-chicken', name: 'Вок с курицей', category: 'Вок', desc: 'Удон, овощи, терияки', price: 2500, prepSeconds: 240, available: true, modifiers: [group('noodle', 'Лапша', true, [{ id: 'n-udon', name: 'Удон', priceDelta: 0, prepSeconds: 0 }, { id: 'n-rice', name: 'Рисовая', priceDelta: 0, prepSeconds: 0 }, { id: 'n-soba', name: 'Гречневая', priceDelta: 200, prepSeconds: 15 }]), sauceGroup] },
  { id: 'w-beef', name: 'Вок с говядиной', category: 'Вок', desc: 'Удон, перец, устричный соус', price: 3200, prepSeconds: 280, available: true, modifiers: [sauceGroup] },
  { id: 'w-veg', name: 'Вок овощной', category: 'Вок', desc: 'Без мяса', price: 2000, prepSeconds: 180, available: true, modifiers: [sauceGroup] },
  { id: 'w-rolls', name: 'Спринг-роллы', category: 'Закуски', desc: '4 шт', price: 1600, prepSeconds: 120, available: true, modifiers: [] },
  { id: 'w-gyoza', name: 'Гёдза', category: 'Закуски', desc: '5 шт', price: 1900, prepSeconds: 150, available: true, modifiers: [] },
  { id: 'w-miso', name: 'Мисо-суп', category: 'Супы', desc: '300 мл', price: 1200, prepSeconds: 50, available: true, modifiers: [] },
  { id: 'w-cola', name: 'Газировка', category: 'Напитки', desc: '0,5 л', price: 700, prepSeconds: 10, available: true, modifiers: [] }
];

/**
 * Районы Алматы для выбора «откуда поеду», если гость не даёт геолокацию.
 * Координаты — центры районов, этого достаточно для оценки времени в пути.
 */
const ALMATY_AREAS = [
  { id: 'almaly',     name: 'Алмалинский (центр)',        lat: 43.2567, lon: 76.9286 },
  { id: 'medeu',      name: 'Медеуский (Достык, выше Абая)', lat: 43.2450, lon: 76.9600 },
  { id: 'bostandyk',  name: 'Бостандыкский (Аль-Фараби)',  lat: 43.2200, lon: 76.9100 },
  { id: 'auezov',     name: 'Ауэзовский (Саина, Абая)',    lat: 43.2300, lon: 76.8700 },
  { id: 'zhetysu',    name: 'Жетысуский (Сайран)',         lat: 43.2750, lon: 76.8800 },
  { id: 'turksib',    name: 'Турксибский (вокзал)',        lat: 43.3200, lon: 76.9500 },
  { id: 'alatau',     name: 'Алатауский (север)',          lat: 43.3100, lon: 76.8800 }
];

function seedVenues() {
  return [
    venueTemplate(
      'nurly-tau-canteen', 'Столовая «Нурлы Тау»', 'Столовая',
      'пр. Аль-Фараби 17, БЦ «Нурлы Тау», блок 1Б',
      'Стойка Express Pick-Up у выхода из зала',
      // Аль-Фараби — постоянные заторы, плюс время на паркинг БЦ
      { lat: 43.2205, lon: 76.9285, congestion: 1.25, parkingMinutes: 5 },
      canteenMenu,
      { kitchenThroughputPerMin: 240, maxOrdersPerSlot: 5, digitalSharePct: 30, baselineOrdersPerHour: 26 }
    ),
    venueTemplate(
      'arbat-cafe', 'Кафе «Арбат»', 'Кафе',
      'ул. Жибек Жолы 55, пешеходная зона',
      'Полка выдачи справа от стойки бариста',
      // Пешеходная зона: ехать некуда, зато парковку искать долго
      { lat: 43.2603, lon: 76.9453, congestion: 1.0, parkingMinutes: 7 },
      cafeMenu,
      { kitchenThroughputPerMin: 150, maxOrdersPerSlot: 4, digitalSharePct: 35, baselineOrdersPerHour: 23,
        serviceHours: { from: '07:30', to: '22:00' } }
    ),
    venueTemplate(
      'dostyk-wok', 'Wok Express (Dostyk Plaza)', 'Фуд-корт',
      'ул. Самал-2, 111, ТРЦ «Dostyk Plaza», 3 этаж',
      'Отдельное окно Pick-Up на фуд-корте',
      // ТРЦ: паркинг плюс подъём на третий этаж
      { lat: 43.2335, lon: 76.9560, congestion: 1.2, parkingMinutes: 8 },
      foodcourtMenu,
      { kitchenThroughputPerMin: 200, maxOrdersPerSlot: 4, digitalSharePct: 25, baselineOrdersPerHour: 22,
        serviceHours: { from: '10:00', to: '22:00' } }
    )
  ];
}

module.exports = { seedVenues, DEFAULT_SETTINGS, ALMATY_AREAS };
