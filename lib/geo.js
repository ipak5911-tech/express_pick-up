'use strict';
/**
 * География и время в пути для Алматы.
 *
 * Зачем это сервису предзаказа: слот выдачи должен быть выполним не только для
 * кухни, но и для гостя. Предлагать интервал через 10 минут человеку, которому
 * ехать 25 минут по Аль-Фараби в обеденный пик, — значит гарантированно получить
 * остывшее блюдо на полке и испорченную метрику.
 *
 * ВАЖНО: пробки здесь — модель, а не живые данные. Она построена на суточном
 * профиле загрузки дорог Алматы и коэффициенте загруженности района заведения.
 * Для продакшена сюда подключается реальный источник (2GIS Directions API или
 * Яндекс.Маршрутизация) — достаточно заменить одну функцию `congestionFactor`,
 * интерфейс остальной системы не меняется.
 */

const EARTH_RADIUS_KM = 6371;

/** Скорость свободного потока по городу с учётом светофоров, км/ч. */
const FREE_FLOW_KMH = 32;

/** Пешком, км/ч. */
const WALK_KMH = 4.6;

/**
 * Квартальная застройка: по прямой никто не ездит.
 * Алматы — регулярная сетка, поэтому реальный путь длиннее воздушной линии.
 */
const DETOUR_CAR = 1.35;
const DETOUR_WALK = 1.25;

/**
 * Суточный профиль загруженности дорог Алматы (будни).
 * Множитель к времени в пути относительно свободного потока.
 */
const HOURLY_CONGESTION = [
  1.00, 1.00, 1.00, 1.00, 1.00, 1.05, // 00–06
  1.25, 1.75, 1.95, 1.60,             // 06–10 утренний пик
  1.30, 1.20,                         // 10–12
  1.45, 1.45,                         // 12–14 обеденный пик — сценарий сервиса
  1.30, 1.30, 1.45,                   // 14–17
  1.90, 2.05, 1.80,                   // 17–20 вечерний пик
  1.35, 1.15, 1.05, 1.00              // 20–24
];

/** Расстояние по большому кругу, км. */
function haversineKm(a, b) {
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Коэффициент пробок на момент времени с поправкой на район заведения.
 * `venueCongestion` — насколько тяжёлая локация: 1.0 обычная улица,
 * 1.25 проспект с постоянными заторами (Аль-Фараби, Достык в час пик).
 */
function congestionFactor(ts, venueCongestion = 1) {
  const d = new Date(ts);
  const hour = d.getHours();
  const day = d.getDay();
  const base = HOURLY_CONGESTION[hour] || 1;
  // В выходные превышение над свободным потоком примерно вдвое меньше
  const weekend = day === 0 || day === 6;
  const adjusted = weekend ? 1 + (base - 1) * 0.5 : base;
  // Поправка района применяется только к заторной части, а не к базовому времени
  return 1 + (adjusted - 1) * venueCongestion;
}

/** Словесная оценка обстановки — для интерфейса. */
function trafficLevel(factor) {
  if (factor >= 1.75) return 'heavy';
  if (factor >= 1.35) return 'moderate';
  return 'light';
}

/**
 * Время в пути, минуты.
 * mode: 'car' | 'walk'. Пешеход пробок не замечает.
 */
function travelMinutes(from, venue, ts = Date.now(), mode = 'car') {
  const straight = haversineKm(from, venue.location);
  if (mode === 'walk') {
    const km = straight * DETOUR_WALK;
    return {
      mode, distanceKm: Math.round(km * 10) / 10,
      minutes: Math.max(1, Math.round((km / WALK_KMH) * 60)),
      factor: 1, level: 'light'
    };
  }
  const km = straight * DETOUR_CAR;
  const factor = congestionFactor(ts, venue.location.congestion || 1);
  // Парковка и подход к точке выдачи: в ТРЦ и БЦ это ощутимые минуты
  const parkingMin = venue.location.parkingMinutes || 3;
  const minutes = Math.max(1, Math.round((km / FREE_FLOW_KMH) * 60 * factor) + parkingMin);
  return {
    mode, distanceKm: Math.round(km * 10) / 10, minutes,
    factor: Math.round(factor * 100) / 100,
    level: trafficLevel(factor),
    parkingMinutes: parkingMin
  };
}

/** Пешком или на машине — что быстрее. Близко к точке ехать бессмысленно. */
function bestTravel(from, venue, ts = Date.now()) {
  const car = travelMinutes(from, venue, ts, 'car');
  const walk = travelMinutes(from, venue, ts, 'walk');
  return walk.minutes <= car.minutes ? walk : car;
}

module.exports = {
  haversineKm, congestionFactor, trafficLevel, travelMinutes, bestTravel,
  FREE_FLOW_KMH, WALK_KMH, HOURLY_CONGESTION
};
