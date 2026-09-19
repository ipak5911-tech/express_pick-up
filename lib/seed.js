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
  { id: 'size-l', name: 'Большая', priceDelta: 300, prepSeconds: 20 }
]);

const sauceGroup = group('sauce', 'Соус', false, [
  { id: 'sauce-none', name: 'Без соуса', priceDelta: 0, prepSeconds: 0 },
  { id: 'sauce-cheese', name: 'Сырный', priceDelta: 200, prepSeconds: 5 },
  { id: 'sauce-spicy', name: 'Острый', priceDelta: 200, prepSeconds: 5 }
]);

// Столовая: комплексные обеды, часть блюд готова на линии, часть — под заказ
const canteenMenu = [
  { id: 'c-borsch', name: 'Борщ с говядиной', category: 'Супы', desc: 'Порция 300 мл, сметана отдельно', price: 900, prepSeconds: 45, available: true, modifiers: [group('extra', 'Дополнительно', false, [{ id: 'sour-cream', name: 'Сметана', priceDelta: 150, prepSeconds: 5 }, { id: 'bread', name: 'Хлеб', priceDelta: 100, prepSeconds: 3 }])] },
  { id: 'c-lagman', name: 'Лагман', category: 'Супы', desc: 'С домашней лапшой', price: 1400, prepSeconds: 90, available: true, modifiers: [] },
  { id: 'c-beshbarmak', name: 'Бешбармак', category: 'Горячее', desc: 'Готовится под заказ', price: 2200, prepSeconds: 300, available: true, modifiers: [] },
  { id: 'c-chicken', name: 'Куриное филе на гриле', category: 'Горячее', desc: 'Готовится под заказ', price: 1800, prepSeconds: 260, available: true, modifiers: [sauceGroup] },
  { id: 'c-plov', name: 'Плов', category: 'Горячее', desc: 'С бараниной', price: 1300, prepSeconds: 60, available: true, modifiers: [] },
  { id: 'c-cutlet', name: 'Котлета по-домашнему', category: 'Горячее', desc: 'С пылу с жару', price: 1000, prepSeconds: 90, available: true, modifiers: [sauceGroup] },
  { id: 'c-buckwheat', name: 'Гречка с овощами', category: 'Гарниры', desc: 'Готово на линии', price: 400, prepSeconds: 25, available: true, modifiers: [sizeGroup] },
  { id: 'c-potato', name: 'Картофельное пюре', category: 'Гарниры', desc: 'Готово на линии', price: 450, prepSeconds: 25, available: true, modifiers: [sizeGroup] },
  { id: 'c-salad', name: 'Салат «Витаминный»', category: 'Салаты', desc: 'Капуста, морковь, масло', price: 400, prepSeconds: 40, available: true, modifiers: [] },
  { id: 'c-compote', name: 'Компот', category: 'Напитки', desc: '250 мл', price: 250, prepSeconds: 10, available: true, modifiers: [] },
  { id: 'c-tea', name: 'Чай', category: 'Напитки', desc: 'Чёрный или зелёный', price: 200, prepSeconds: 10, available: true, modifiers: [group('tea', 'Вид', true, [{ id: 'tea-black', name: 'Чёрный', priceDelta: 0, prepSeconds: 0 }, { id: 'tea-green', name: 'Зелёный', priceDelta: 0, prepSeconds: 0 }])] }
];

// Кофейня: напитки под заказ, выпечка и еда с витрины
const cafeMenu = [
  { id: 'k-americano', name: 'Американо', category: 'Кофе', desc: '300 мл', price: 900, prepSeconds: 45, available: true, modifiers: [] },
  { id: 'k-cappuccino', name: 'Капучино', category: 'Кофе', desc: '300 мл', price: 1200, prepSeconds: 70, available: true, modifiers: [group('milk', 'Молоко', true, [{ id: 'milk-cow', name: 'Обычное', priceDelta: 0, prepSeconds: 0 }, { id: 'milk-oat', name: 'Овсяное', priceDelta: 400, prepSeconds: 0 }, { id: 'milk-lactfree', name: 'Безлактозное', priceDelta: 400, prepSeconds: 0 }])] },
  { id: 'k-latte', name: 'Латте', category: 'Кофе', desc: '400 мл', price: 1300, prepSeconds: 70, available: true, modifiers: [group('milk2', 'Молоко', true, [{ id: 'milk2-cow', name: 'Обычное', priceDelta: 0, prepSeconds: 0 }, { id: 'milk2-oat', name: 'Овсяное', priceDelta: 400, prepSeconds: 0 }])] },
  { id: 'k-raf', name: 'Раф', category: 'Кофе', desc: 'Сливочный, 300 мл', price: 1600, prepSeconds: 90, available: true, modifiers: [] },
  { id: 'k-sandwich', name: 'Сэндвич с курицей', category: 'Еда', desc: 'На гриле', price: 1900, prepSeconds: 150, available: true, modifiers: [group('heat', 'Подача', true, [{ id: 'heat-hot', name: 'Разогреть', priceDelta: 0, prepSeconds: 60 }, { id: 'heat-cold', name: 'Холодный', priceDelta: 0, prepSeconds: 0 }])] },
  { id: 'k-bowl', name: 'Боул с киноа', category: 'Еда', desc: 'Овощи, курица, соус', price: 2600, prepSeconds: 200, available: true, modifiers: [sauceGroup] },
  { id: 'k-croissant', name: 'Круассан', category: 'Выпечка', desc: 'Классический', price: 800, prepSeconds: 20, available: true, modifiers: [group('fill', 'Начинка', false, [{ id: 'fill-choco', name: 'Шоколад', priceDelta: 350, prepSeconds: 10 }, { id: 'fill-ham', name: 'Ветчина и сыр', priceDelta: 600, prepSeconds: 45 }])] },
  { id: 'k-cheesecake', name: 'Чизкейк', category: 'Выпечка', desc: 'Нью-Йорк', price: 1700, prepSeconds: 20, available: true, modifiers: [] }
];

// Фаст-фуд на фуд-корте: всё под заказ, высокая оборачиваемость
const fastfoodMenu = [
  { id: 's-shawarma', name: 'Шаурма классическая', category: 'Шаурма', desc: 'Курица, овощи, соус', price: 1800, prepSeconds: 180, available: true, modifiers: [sauceGroup] },
  { id: 's-shawarma-xl', name: 'Шаурма большая', category: 'Шаурма', desc: 'Двойная порция мяса', price: 2400, prepSeconds: 240, available: true, modifiers: [sauceGroup] },
  { id: 's-doner', name: 'Донер в лаваше', category: 'Шаурма', desc: 'С говядиной', price: 1900, prepSeconds: 200, available: true, modifiers: [sauceGroup] },
  { id: 's-fries', name: 'Картофель фри', category: 'Закуски', desc: 'Большая порция', price: 700, prepSeconds: 150, available: true, modifiers: [] },
  { id: 's-nuggets', name: 'Наггетсы', category: 'Закуски', desc: '6 шт', price: 1200, prepSeconds: 170, available: true, modifiers: [sauceGroup] },
  { id: 's-ayran', name: 'Айран', category: 'Напитки', desc: '0,5 л', price: 400, prepSeconds: 10, available: true, modifiers: [] },
  { id: 's-cola', name: 'Газировка', category: 'Напитки', desc: '0,5 л', price: 600, prepSeconds: 10, available: true, modifiers: [] }
];


// Пиццерия: печь — узкое место, порции долгие, но параллелятся
const pizzaMenu = [
  { id: 'p-margherita', name: 'Маргарита', category: 'Пицца', desc: '30 см', price: 2600, prepSeconds: 420, available: true, modifiers: [group('dough', 'Тесто', true, [{ id: 'dough-thin', name: 'Тонкое', priceDelta: 0, prepSeconds: 0 }, { id: 'dough-thick', name: 'Пышное', priceDelta: 0, prepSeconds: 60 }])] },
  { id: 'p-pepperoni', name: 'Пепперони', category: 'Пицца', desc: '30 см, острая', price: 3200, prepSeconds: 450, available: true, modifiers: [] },
  { id: 'p-fourcheese', name: 'Четыре сыра', category: 'Пицца', desc: '30 см', price: 3600, prepSeconds: 450, available: true, modifiers: [] },
  { id: 'p-caesar', name: 'Цезарь с курицей', category: 'Салаты', desc: 'Классический', price: 2200, prepSeconds: 120, available: true, modifiers: [] },
  { id: 'p-bruschetta', name: 'Брускетта', category: 'Закуски', desc: '2 шт, томаты и базилик', price: 1400, prepSeconds: 90, available: true, modifiers: [] },
  { id: 'p-tiramisu', name: 'Тирамису', category: 'Десерты', desc: 'Порция', price: 1800, prepSeconds: 20, available: true, modifiers: [] },
  { id: 'p-lemonade', name: 'Домашний лимонад', category: 'Напитки', desc: '400 мл', price: 1200, prepSeconds: 40, available: true, modifiers: [] }
];

// Кофейня с завтраками: напитки быстрые, горячее под заказ
const breakfastMenu = [
  { id: 'b-flatwhite', name: 'Флэт уайт', category: 'Кофе', desc: '250 мл', price: 1400, prepSeconds: 70, available: true, modifiers: [group('milkb', 'Молоко', true, [{ id: 'milkb-cow', name: 'Обычное', priceDelta: 0, prepSeconds: 0 }, { id: 'milkb-oat', name: 'Овсяное', priceDelta: 400, prepSeconds: 0 }])] },
  { id: 'b-filter', name: 'Фильтр-кофе', category: 'Кофе', desc: '300 мл', price: 1100, prepSeconds: 50, available: true, modifiers: [] },
  { id: 'b-syrniki', name: 'Сырники', category: 'Завтраки', desc: 'Со сметаной и вареньем', price: 2400, prepSeconds: 300, available: true, modifiers: [] },
  { id: 'b-scrambled', name: 'Скрэмбл с авокадо', category: 'Завтраки', desc: 'На тосте', price: 2800, prepSeconds: 260, available: true, modifiers: [] },
  { id: 'b-porridge', name: 'Овсяная каша', category: 'Завтраки', desc: 'С ягодами', price: 1600, prepSeconds: 120, available: true, modifiers: [] },
  { id: 'b-cinnamon', name: 'Булочка с корицей', category: 'Выпечка', desc: 'Свежая', price: 1000, prepSeconds: 20, available: true, modifiers: [] },
  { id: 'b-orange', name: 'Свежевыжатый апельсиновый', category: 'Напитки', desc: '300 мл', price: 1800, prepSeconds: 60, available: true, modifiers: [] }
];

// Грузинская кухня: тесто и мангал — самые долгие позиции в пилоте
const georgianMenu = [
  { id: 'g-khachapuri', name: 'Хачапури по-аджарски', category: 'Выпечка', desc: 'С яйцом и маслом', price: 2900, prepSeconds: 480, available: true, modifiers: [] },
  { id: 'g-khinkali', name: 'Хинкали', category: 'Горячее', desc: '5 шт, с говядиной', price: 2500, prepSeconds: 360, available: true, modifiers: [] },
  { id: 'g-shashlik', name: 'Шашлык из курицы', category: 'Мангал', desc: 'Порция 250 г', price: 3400, prepSeconds: 540, available: true, modifiers: [sauceGroup] },
  { id: 'g-lobio', name: 'Лобио', category: 'Горячее', desc: 'С зеленью', price: 1900, prepSeconds: 90, available: true, modifiers: [] },
  { id: 'g-salad', name: 'Салат по-грузински', category: 'Салаты', desc: 'Помидоры, огурцы, орех', price: 1700, prepSeconds: 70, available: true, modifiers: [] },
  { id: 'g-lavash', name: 'Лаваш', category: 'Выпечка', desc: 'Свежий', price: 500, prepSeconds: 30, available: true, modifiers: [] },
  { id: 'g-tarhun', name: 'Тархун', category: 'Напитки', desc: '0,5 л', price: 800, prepSeconds: 10, available: true, modifiers: [] }
];

// Восточная кухня на фуд-корте: плов готовится партиями, отдача быстрая
const easternMenu = [
  { id: 'e-plov', name: 'Плов с бараниной', category: 'Горячее', desc: 'Порция 350 г', price: 2100, prepSeconds: 80, available: true, modifiers: [sizeGroup] },
  { id: 'e-manty', name: 'Манты', category: 'Горячее', desc: '4 шт', price: 1900, prepSeconds: 300, available: true, modifiers: [] },
  { id: 'e-samsa', name: 'Самса', category: 'Выпечка', desc: '2 шт, из тандыра', price: 1200, prepSeconds: 60, available: true, modifiers: [] },
  { id: 'e-shorpa', name: 'Шорпа', category: 'Супы', desc: '350 мл', price: 1500, prepSeconds: 70, available: true, modifiers: [] },
  { id: 'e-achichuk', name: 'Ачик-чучук', category: 'Салаты', desc: 'Помидоры с луком', price: 900, prepSeconds: 50, available: true, modifiers: [] },
  { id: 'e-tea', name: 'Чай в чайнике', category: 'Напитки', desc: '0,6 л', price: 700, prepSeconds: 40, available: true, modifiers: [] }
];

// Экспресс-кофейня: всё быстро, узкое место — кофемашина
const expressCoffeeMenu = [
  { id: 'x-espresso', name: 'Эспрессо', category: 'Кофе', desc: '30 мл', price: 700, prepSeconds: 35, available: true, modifiers: [] },
  { id: 'x-americano', name: 'Американо', category: 'Кофе', desc: '300 мл', price: 900, prepSeconds: 45, available: true, modifiers: [] },
  { id: 'x-cappuccino', name: 'Капучино', category: 'Кофе', desc: '300 мл', price: 1100, prepSeconds: 65, available: true, modifiers: [] },
  { id: 'x-croissant', name: 'Круассан', category: 'Выпечка', desc: 'Классический', price: 750, prepSeconds: 20, available: true, modifiers: [] },
  { id: 'x-cookie', name: 'Печенье', category: 'Выпечка', desc: 'Овсяное', price: 500, prepSeconds: 15, available: true, modifiers: [] }
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
      'kaganat-abay', 'Каганат', 'Столовая',
      'пр. Абая 44',
      'Стойка Express Pick-Up у выхода из зала',
      { lat: 43.2418, lon: 76.9447, congestion: 1.15, parkingMinutes: 4 },
      canteenMenu,
      { kitchenThroughputPerMin: 240, maxOrdersPerSlot: 5, digitalSharePct: 30, baselineOrdersPerHour: 26,
        serviceHours: { from: '08:00', to: '20:00' } }
    ),
    venueTemplate(
      'coffeeboom-arbat', 'Coffee BOOM', 'Кофейня',
      'ул. Жибек Жолы 55, Арбат',
      'Полка выдачи справа от стойки бариста',
      // Пешеходная зона: ехать некуда, зато парковку в центре искать долго
      { lat: 43.2603, lon: 76.9453, congestion: 1.0, parkingMinutes: 7 },
      cafeMenu,
      { kitchenThroughputPerMin: 150, maxOrdersPerSlot: 4, digitalSharePct: 35, baselineOrdersPerHour: 23,
        serviceHours: { from: '07:30', to: '22:00' } }
    ),
    venueTemplate(
      'salambro-dostyk', 'Salam Bro', 'Фаст-фуд',
      'ул. Самал-2, 111, ТРЦ «Dostyk Plaza», фуд-корт',
      'Отдельное окно Pick-Up на фуд-корте',
      // ТРЦ: паркинг плюс подъём на этаж фуд-корта
      { lat: 43.2335, lon: 76.9560, congestion: 1.2, parkingMinutes: 8 },
      fastfoodMenu,
      { kitchenThroughputPerMin: 200, maxOrdersPerSlot: 4, digitalSharePct: 25, baselineOrdersPerHour: 22,
        serviceHours: { from: '10:00', to: '22:00' } }
    ),
    venueTemplate(
      'delpapa-farabi', 'Del Papa', 'Пиццерия',
      'пр. Аль-Фараби 77/8, район Esentai',
      'Стойка выдачи у входа',
      // Аль-Фараби — постоянные заторы
      { lat: 43.2185, lon: 76.9270, congestion: 1.3, parkingMinutes: 6 },
      pizzaMenu,
      { kitchenThroughputPerMin: 300, maxOrdersPerSlot: 4, digitalSharePct: 30, baselineOrdersPerHour: 18,
        maxEarlyCookSlots: 5, serviceHours: { from: '11:00', to: '23:00' } }
    ),
    venueTemplate(
      'bahandi-dostyk', 'Bahandi', 'Кофейня',
      'пр. Достык 210',
      'Полка выдачи у кассы',
      { lat: 43.2270, lon: 76.9600, congestion: 1.25, parkingMinutes: 5 },
      breakfastMenu,
      { kitchenThroughputPerMin: 170, maxOrdersPerSlot: 4, digitalSharePct: 35, baselineOrdersPerHour: 21,
        serviceHours: { from: '08:00', to: '21:00' } }
    ),
    venueTemplate(
      'daredzhani-kunaev', 'Дареджани', 'Грузинская кухня',
      'ул. Кунаева 77',
      'Отдельная стойка навынос у входа',
      { lat: 43.2530, lon: 76.9490, congestion: 1.1, parkingMinutes: 6 },
      georgianMenu,
      { kitchenThroughputPerMin: 320, maxOrdersPerSlot: 3, digitalSharePct: 25, baselineOrdersPerHour: 16,
        maxEarlyCookSlots: 6, serviceHours: { from: '11:00', to: '23:00' } }
    ),
    venueTemplate(
      'mega-foodcourt', 'Фуд-корт Mega Almaty', 'Фуд-корт',
      'ул. Розыбакиева 247а, ТРЦ Mega, 2 этаж',
      'Окно Express Pick-Up в центре фуд-корта',
      // Крупный ТРЦ: паркинг и путь до фуд-корта заметно длиннее
      { lat: 43.2200, lon: 76.8880, congestion: 1.25, parkingMinutes: 10 },
      easternMenu,
      { kitchenThroughputPerMin: 260, maxOrdersPerSlot: 6, digitalSharePct: 25, baselineOrdersPerHour: 28,
        serviceHours: { from: '10:00', to: '22:00' } }
    ),
    venueTemplate(
      'cofix-abylaikhan', 'Cofix', 'Экспресс-кофейня',
      'пр. Абылай хана 92',
      'Стойка выдачи справа от входа',
      { lat: 43.2565, lon: 76.9430, congestion: 1.1, parkingMinutes: 6 },
      expressCoffeeMenu,
      { kitchenThroughputPerMin: 120, maxOrdersPerSlot: 6, digitalSharePct: 40, baselineOrdersPerHour: 30,
        slotMinutes: 5, minLeadMinutes: 6, serviceHours: { from: '07:00', to: '21:00' } }
    )
  ];
}

module.exports = { seedVenues, DEFAULT_SETTINGS, ALMATY_AREAS };
