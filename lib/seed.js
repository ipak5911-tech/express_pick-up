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
  serviceHours: { from: '11:00', to: '16:30' },
  autoKitchen: false,             // демо-режим: кухня двигает статусы сама
  baselineWaitSeconds: 1200,      // замер «до»: 20 минут от входа до получения
  baselineOrdersPerHour: 24       // замер «до»: выдач в час в обеденный пик
};

function group(id, name, required, options) {
  return { id, name, required, options };
}

function venueTemplate(id, name, kind, address, pickupPoint, menu, overrides = {}) {
  return {
    id, name, kind, address, pickupPoint,
    settings: Object.assign({}, DEFAULT_SETTINGS, overrides),
    menu
  };
}

const sizeGroup = group('size', 'Порция', true, [
  { id: 'size-s', name: 'Стандарт', priceDelta: 0, prepSeconds: 0 },
  { id: 'size-l', name: 'Большая', priceDelta: 90, prepSeconds: 20 }
]);

const sauceGroup = group('sauce', 'Соус', false, [
  { id: 'sauce-none', name: 'Без соуса', priceDelta: 0, prepSeconds: 0 },
  { id: 'sauce-cheese', name: 'Сырный', priceDelta: 40, prepSeconds: 5 },
  { id: 'sauce-spicy', name: 'Острый', priceDelta: 40, prepSeconds: 5 }
]);

const canteenMenu = [
  { id: 'c-soup', name: 'Борщ с говядиной', category: 'Супы', desc: 'Порция 300 мл, сметана отдельно', price: 220, prepSeconds: 45, available: true, modifiers: [group('extra', 'Дополнительно', false, [{ id: 'sour-cream', name: 'Сметана', priceDelta: 30, prepSeconds: 5 }, { id: 'bread', name: 'Хлеб', priceDelta: 20, prepSeconds: 3 }])] },
  { id: 'c-chicken', name: 'Куриное филе на гриле', category: 'Горячее', desc: 'Готовится под заказ', price: 320, prepSeconds: 260, available: true, modifiers: [sauceGroup] },
  { id: 'c-cutlet', name: 'Котлета домашняя', category: 'Горячее', desc: 'С пылу с жару', price: 240, prepSeconds: 90, available: true, modifiers: [sauceGroup] },
  { id: 'c-fish', name: 'Треска запечённая', category: 'Горячее', desc: 'С лимоном', price: 380, prepSeconds: 300, available: true, modifiers: [] },
  { id: 'c-buckwheat', name: 'Гречка с овощами', category: 'Гарниры', desc: 'Готово на линии', price: 120, prepSeconds: 25, available: true, modifiers: [sizeGroup] },
  { id: 'c-potato', name: 'Картофельное пюре', category: 'Гарниры', desc: 'Готово на линии', price: 130, prepSeconds: 25, available: true, modifiers: [sizeGroup] },
  { id: 'c-salad', name: 'Салат «Витаминный»', category: 'Салаты', desc: 'Капуста, морковь, масло', price: 110, prepSeconds: 40, available: true, modifiers: [] },
  { id: 'c-olivier', name: 'Оливье', category: 'Салаты', desc: 'Классический', price: 160, prepSeconds: 30, available: true, modifiers: [] },
  { id: 'c-compote', name: 'Компот', category: 'Напитки', desc: '250 мл', price: 60, prepSeconds: 10, available: true, modifiers: [] },
  { id: 'c-tea', name: 'Чай', category: 'Напитки', desc: 'Чёрный или зелёный', price: 50, prepSeconds: 10, available: true, modifiers: [group('tea', 'Вид', true, [{ id: 'tea-black', name: 'Чёрный', priceDelta: 0, prepSeconds: 0 }, { id: 'tea-green', name: 'Зелёный', priceDelta: 0, prepSeconds: 0 }])] }
];

const cafeMenu = [
  { id: 'k-latte', name: 'Латте', category: 'Кофе', desc: '300 мл', price: 230, prepSeconds: 70, available: true, modifiers: [group('milk', 'Молоко', true, [{ id: 'milk-cow', name: 'Обычное', priceDelta: 0, prepSeconds: 0 }, { id: 'milk-oat', name: 'Овсяное', priceDelta: 60, prepSeconds: 0 }, { id: 'milk-lactfree', name: 'Безлактозное', priceDelta: 60, prepSeconds: 0 }])] },
  { id: 'k-americano', name: 'Американо', category: 'Кофе', desc: '300 мл', price: 180, prepSeconds: 45, available: true, modifiers: [] },
  { id: 'k-sandwich', name: 'Сэндвич с индейкой', category: 'Еда', desc: 'На гриле', price: 340, prepSeconds: 150, available: true, modifiers: [group('heat', 'Подача', true, [{ id: 'heat-hot', name: 'Разогреть', priceDelta: 0, prepSeconds: 60 }, { id: 'heat-cold', name: 'Холодный', priceDelta: 0, prepSeconds: 0 }])] },
  { id: 'k-bowl', name: 'Боул с курицей', category: 'Еда', desc: 'Киноа, овощи, соус', price: 420, prepSeconds: 200, available: true, modifiers: [sauceGroup] },
  { id: 'k-soup', name: 'Крем-суп тыквенный', category: 'Еда', desc: '300 мл', price: 260, prepSeconds: 60, available: true, modifiers: [] },
  { id: 'k-croissant', name: 'Круассан', category: 'Выпечка', desc: 'Классический', price: 150, prepSeconds: 20, available: true, modifiers: [group('fill', 'Начинка', false, [{ id: 'fill-choco', name: 'Шоколад', priceDelta: 50, prepSeconds: 10 }, { id: 'fill-ham', name: 'Ветчина и сыр', priceDelta: 90, prepSeconds: 45 }])] },
  { id: 'k-cheesecake', name: 'Чизкейк', category: 'Выпечка', desc: 'Нью-Йорк', price: 280, prepSeconds: 20, available: true, modifiers: [] },
  { id: 'k-lemonade', name: 'Лимонад', category: 'Напитки', desc: '400 мл', price: 200, prepSeconds: 40, available: true, modifiers: [] }
];

const foodcourtMenu = [
  { id: 'w-chicken', name: 'Вок с курицей', category: 'Вок', desc: 'Удон, овощи, терияки', price: 390, prepSeconds: 240, available: true, modifiers: [group('noodle', 'Лапша', true, [{ id: 'n-udon', name: 'Удон', priceDelta: 0, prepSeconds: 0 }, { id: 'n-rice', name: 'Рисовая', priceDelta: 0, prepSeconds: 0 }, { id: 'n-soba', name: 'Гречневая', priceDelta: 30, prepSeconds: 15 }]), sauceGroup] },
  { id: 'w-beef', name: 'Вок с говядиной', category: 'Вок', desc: 'Удон, перец, устричный соус', price: 470, prepSeconds: 280, available: true, modifiers: [sauceGroup] },
  { id: 'w-veg', name: 'Вок овощной', category: 'Вок', desc: 'Без мяса', price: 320, prepSeconds: 180, available: true, modifiers: [sauceGroup] },
  { id: 'w-rolls', name: 'Спринг-роллы', category: 'Закуски', desc: '4 шт', price: 240, prepSeconds: 120, available: true, modifiers: [] },
  { id: 'w-gyoza', name: 'Гёдза', category: 'Закуски', desc: '5 шт', price: 290, prepSeconds: 150, available: true, modifiers: [] },
  { id: 'w-miso', name: 'Мисо-суп', category: 'Супы', desc: '300 мл', price: 190, prepSeconds: 50, available: true, modifiers: [] },
  { id: 'w-cola', name: 'Газировка', category: 'Напитки', desc: '0,5 л', price: 150, prepSeconds: 10, available: true, modifiers: [] }
];

function seedVenues() {
  return [
    venueTemplate('canteen-panorama', 'Столовая «Панорама»', 'Столовая', 'БЦ «Панорама», 1 этаж', 'Стойка Express Pick-Up у выхода из зала', canteenMenu, {
      kitchenThroughputPerMin: 240, maxOrdersPerSlot: 5, digitalSharePct: 30, baselineOrdersPerHour: 26
    }),
    venueTemplate('cafe-bublik', 'Кафе «Бублик»', 'Кафе', 'ул. Ленина, 14', 'Полка выдачи справа от кассы', cafeMenu, {
      kitchenThroughputPerMin: 150, maxOrdersPerSlot: 4, digitalSharePct: 35, baselineOrdersPerHour: 23,
      serviceHours: { from: '08:00', to: '20:00' }
    }),
    venueTemplate('foodcourt-wok', 'Wok Express (фуд-корт)', 'Фуд-корт', 'ТЦ «Меридиан», 3 этаж', 'Отдельное окно Pick-Up', foodcourtMenu, {
      kitchenThroughputPerMin: 200, maxOrdersPerSlot: 4, digitalSharePct: 25, baselineOrdersPerHour: 22,
      serviceHours: { from: '10:00', to: '21:00' }
    })
  ];
}

module.exports = { seedVenues, DEFAULT_SETTINGS };
