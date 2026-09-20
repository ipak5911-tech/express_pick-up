'use strict';
/**
 * Письма гостю о ходе заказа.
 *
 * Гость не обязан держать вкладку открытой: браузерные уведомления работают
 * не везде (iOS без «добавить на экран», закрытая вкладка), а письмо
 * доходит всегда и хранит ссылку на живой статус. Поэтому на каждое важное
 * событие заказа уходит письмо с той же приватной ссылкой /o/<token>.
 *
 * Что считается важным: принят, готов, выдан, снят заведением, неявка.
 * «Готовится» не рассылается — это шум: между «принят» и «готов» гостю
 * делать нечего. Демонстрационные заказы и заказы с кассы писем не получают.
 */
const store = require('./store');
const mail = require('./mail');

let baseUrlFn = () => `http://localhost:${process.env.PORT || 3000}`;
let started = false;

const fmtMoney = n => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₸`;
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Время слота в часовом поясе заведения (сервер работает в нём же). */
function hhmm(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const TEXT = {
  ru: {
    hello: name => (name ? `Здравствуйте, ${name}!` : 'Здравствуйте!'),
    accepted: { subject: (o, v) => `Заказ №${o.code} принят — выдача в ${hhmm(o.slotStart)}, ${v.name}`,
      lead: (o, v) => `Заказ поставлен в очередь кухни ${v.name}. Готов будет к ${hhmm(o.slotStart)} — подходите к этому времени, ждать не придётся.`,
      next: 'Мы напишем, когда заказ будет готов. Статус меняется в реальном времени по ссылке ниже.' },
    ready: { subject: (o, v) => `Заказ №${o.code} готов — заберите на стойке ${v.name}`,
      lead: (o, v) => `Заказ готов и ждёт вас: ${v.pickupPoint}, ${v.address}.`,
      next: 'Откройте ссылку и покажите QR-код сотруднику — заказ отметится выданным.' },
    picked_up: { subject: (o, v) => `Заказ №${o.code} выдан — спасибо, что были в ${v.name}`,
      lead: () => 'Заказ передан вам. Приятного аппетита!',
      next: 'Если найдётся минута — оцените выдачу по ссылке ниже. Это помогает заведению держать время.' },
    cancelled: { subject: (o, v) => `Заказ №${o.code} снят заведением ${v.name}`,
      lead: o => `К сожалению, заведение не смогло выполнить заказ${o.cancelReason ? `: ${o.cancelReason}` : ''}.`,
      next: o => (o.refund === 'due' ? 'Оплата будет возвращена тем же способом, каким была внесена.' : 'Деньги не списывались — заказ был с оплатой на месте.') },
    no_show: { subject: (o, v) => `Заказ №${o.code} снят с выдачи — ${v.name}`,
      lead: o => `Заказ был готов к ${hhmm(o.slotStart)}, но его не забрали, и он снят с табло выдачи.`,
      next: 'Если вы всё же рядом — подойдите к стойке и назовите номер заказа.' },
    order: 'Состав заказа', total: 'Итого', pickup: 'Точка выдачи', time: 'Время выдачи',
    link: 'Следить за заказом', footer: 'Это письмо отправлено автоматически: вы указали почту при заказе в Express Pick-Up.'
  },
  en: {
    hello: name => (name ? `Hello, ${name}!` : 'Hello!'),
    accepted: { subject: (o, v) => `Order ${o.code} accepted — pick-up at ${hhmm(o.slotStart)}, ${v.name}`,
      lead: (o, v) => `Your order is queued in the kitchen at ${v.name}. It will be ready by ${hhmm(o.slotStart)} — come at that time and skip the wait.`,
      next: 'We will email you when it is ready. The status updates live at the link below.' },
    ready: { subject: (o, v) => `Order ${o.code} is ready — collect it at ${v.name}`,
      lead: (o, v) => `Your order is ready and waiting: ${v.pickupPoint}, ${v.address}.`,
      next: 'Open the link and show the QR code to staff — the order will be marked as collected.' },
    picked_up: { subject: (o, v) => `Order ${o.code} collected — thank you for visiting ${v.name}`,
      lead: () => 'Your order has been handed over. Enjoy your meal!',
      next: 'If you have a minute, rate the handoff at the link below. It helps the venue keep its timing.' },
    cancelled: { subject: (o, v) => `Order ${o.code} was cancelled by ${v.name}`,
      lead: o => `Unfortunately the venue could not fulfil your order${o.cancelReason ? `: ${o.cancelReason}` : ''}.`,
      next: o => (o.refund === 'due' ? 'Your payment will be refunded the same way it was made.' : 'Nothing was charged — the order was pay-on-site.') },
    no_show: { subject: (o, v) => `Order ${o.code} removed from the counter — ${v.name}`,
      lead: o => `The order was ready at ${hhmm(o.slotStart)} but was not collected, so it left the pick-up board.`,
      next: 'If you are still nearby, come to the counter and give your order number.' },
    order: 'Your order', total: 'Total', pickup: 'Pick-up point', time: 'Pick-up time',
    link: 'Track the order', footer: 'This is an automatic email: you gave this address when ordering with Express Pick-Up.'
  }
};

/** Событие письма по статусу заказа; null — писать не о чем. */
function eventFor(order) {
  if (order.status === 'new' || order.status === 'cooking') return 'accepted';
  if (order.status === 'ready') return 'ready';
  if (order.status === 'picked_up') return 'picked_up';
  if (order.status === 'cancelled') return order.cancelledBy === 'venue' ? 'cancelled' : null;
  if (order.status === 'no_show') return 'no_show';
  return null;
}

function compose(order, venue, event) {
  const L = TEXT[order.lang === 'en' ? 'en' : 'ru'];
  const tpl = L[event];
  const url = `${baseUrlFn()}/o/${order.token}`;
  const lead = tpl.lead(order, venue);
  const next = typeof tpl.next === 'function' ? tpl.next(order, venue) : tpl.next;
  const lines = order.lines.map(l => `${l.name}${l.optionNames && l.optionNames.length ? ` (${l.optionNames.join(', ')})` : ''} × ${l.qty} — ${fmtMoney(l.total)}`);

  const text = [
    L.hello(order.guestName), '', lead, '',
    `${L.pickup}: ${venue.pickupPoint}, ${venue.address}`,
    `${L.time}: ${hhmm(order.slotStart)}`, '',
    `${L.order}:`, ...lines.map(l => `  • ${l}`), `${L.total}: ${fmtMoney(order.total)}`, '',
    next, '', `${L.link}: ${url}`, '', L.footer
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16191d">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#e8590c;color:#fff;padding:18px 22px;font-weight:800;font-size:18px">Express Pick-Up</div>
  <div style="padding:22px">
    <p style="margin:0 0 12px;font-size:16px">${escapeHtml(L.hello(order.guestName))}</p>
    <p style="margin:0 0 16px;font-size:16px;line-height:1.45">${escapeHtml(lead)}</p>
    <div style="display:flex;gap:12px;margin:0 0 16px;padding:12px 14px;background:#fff4ec;border-radius:12px">
      <div style="flex:1"><div style="font-size:12px;color:#6b7280">${L.time}</div><div style="font-size:26px;font-weight:800">${hhmm(order.slotStart)}</div></div>
      <div style="flex:2"><div style="font-size:12px;color:#6b7280">${L.pickup}</div><div style="font-weight:700">${escapeHtml(venue.pickupPoint)}</div><div style="font-size:13px;color:#6b7280">${escapeHtml(venue.name)} · ${escapeHtml(venue.address)}</div></div>
    </div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:6px">${L.order} · №${escapeHtml(order.code)}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${lines.map(l => `<tr><td style="padding:5px 0;border-bottom:1px solid #f0f1f3">${escapeHtml(l)}</td></tr>`).join('')}
      <tr><td style="padding:8px 0;font-weight:800">${L.total}: ${fmtMoney(order.total)}</td></tr></table>
    <p style="margin:16px 0;line-height:1.45">${escapeHtml(next)}</p>
    <a href="${url}" style="display:block;text-align:center;background:#15803d;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700;font-size:16px">${L.link} → №${escapeHtml(order.code)}</a>
    <p style="margin:14px 0 0;font-size:12px;color:#9ca3af;word-break:break-all">${escapeHtml(url)}</p>
  </div>
  <div style="padding:12px 22px;font-size:12px;color:#9ca3af;border-top:1px solid #f0f1f3">${escapeHtml(L.footer)}</div>
</div></body></html>`;

  return { subject: tpl.subject(order, venue), text, html };
}

/** Отправить письмо о текущем состоянии заказа (если есть кому и о чём). */
function notifyOrder(order, forcedEvent) {
  if (!order || !order.email || order.demo || order.channel === 'counter') return null;
  const event = forcedEvent || eventFor(order);
  if (!event) return null;
  const venue = store.venue(order.venueId);
  if (!venue) return null;
  const msg = compose(order, venue, event);
  return mail.send(Object.assign(msg, {
    to: order.email, event, venueId: order.venueId, orderId: order.id, orderCode: order.code
  }));
}

function onChange(ev) {
  if (!ev || !ev.orderId) return;
  if (!['order_created', 'order_status', 'order_email'].includes(ev.type)) return;
  const order = store.orderById(ev.orderId);
  if (!order) return;
  // «Готовится» письма не заслуживает; остальные переходы — да.
  if (ev.type === 'order_status' && ev.status === 'cooking') return;
  try { notifyOrder(order); } catch (e) { console.error('Почта:', e.message); }
}

/** Подписка на события заказов. baseUrl — как гостю открыть ссылку с телефона. */
function start({ baseUrl } = {}) {
  if (baseUrl) baseUrlFn = baseUrl;
  if (started) return;
  started = true;
  store.bus.on('change', onChange);
}

module.exports = { start, notifyOrder, compose, eventFor };
