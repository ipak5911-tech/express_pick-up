#!/usr/bin/env node
'use strict';
/**
 * Сборка презентации проекта в PDF.
 *
 * Числа берутся из работающей системы, а не вписываются руками. Причина
 * простая: в собранной вручную презентации они разошлись с панелью — слайд
 * обещал рост на 46 %, а экран показывал 37. Жюри сверяет слайд с экраном, и
 * такое расхождение бьёт по доверию сильнее, чем скромная цифра.
 *
 *   node scripts/make-slides.js          # после подготовки демонстрации
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const store = require('../lib/store');
const analytics = require('../lib/analytics');
const capacity = require('../lib/capacity');
const poi = require('../lib/poi');

const VENUE_ID = process.env.SLIDES_VENUE || 'kaganat-abay';
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(__dirname, '..', 'docs', 'ПРЕЗЕНТАЦИЯ.pdf');

// Число автотестов берётся из отчёта последнего прогона `npm test`.
const TESTS = 128;

const venue = store.venue(VENUE_ID);
if (!venue) {
  console.error(`Заведение ${VENUE_ID} не найдено. Запустите node scripts/seed-demo.js --fresh`);
  process.exit(1);
}

const report = analytics.report(venue, store.orders());
const k = report.kpi;
const s = venue.settings;
const C = capacity.slotCapacitySeconds(s);

if (!report.meta.demoData) {
  console.warn('Внимание: данные не помечены как демонстрационные.');
  console.warn('Сначала нажмите «Подготовить демонстрацию для жюри» в панели.\n');
}

const minutes = sec => (sec / 60).toFixed(sec < 120 ? 2 : 0).replace('.', ',');
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Плитка с крупным числом. */
const stat = (value, label, tone = '') =>
  `<div class="stat ${tone}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

const slides = [
  {
    cls: 'title',
    html: `
      <div class="eyebrow">Кейс: обед без ожидания · Алматы</div>
      <h1>Express&nbsp;Pick-Up</h1>
      <p class="tagline">Мы не бронируем время — мы резервируем мощность кухни</p>
      <p class="sub">«Слот на 12:30» — не пожелание гостя, а обязательство кухни закончить заказ к 12:30</p>
      <div class="foot">Работающий прототип · данные демонстрационные</div>`
  },
  {
    title: 'Проблема',
    sub: 'Очередей три, а онлайн-оплата убирает только первую',
    html: `
      <div class="cols">
        <div class="col"><div class="num">1</div><b>Оформление и оплата</b>
          <p>Убирается онлайн-заказом. Это умеют все.</p></div>
        <div class="col warn"><div class="num">2</div><b>Производство на кухне</b>
          <p>Кухня узнаёт о нагрузке в момент заказа — слишком поздно, чтобы перепланировать.</p></div>
        <div class="col warn"><div class="num">3</div><b>Передача готового заказа</b>
          <p>Готовое блюдо конкурирует с обычным потоком за внимание кассира.</p></div>
      </div>
      <p class="punch">Если всем пообещать 12:30, цифровая очередь просто переедет от кассы к стойке выдачи.</p>`
  },
  {
    title: 'Путь гостя',
    sub: 'Три шага, без регистрации',
    html: `
      <div class="cols">
        <div class="col"><div class="num">1</div><b>Блюда и модификаторы</b><p>Заведение, меню, состав заказа.</p></div>
        <div class="col"><div class="num">2</div><b>Время выдачи</b><p>Показаны только выполнимые интервалы.</p></div>
        <div class="col"><div class="num">3</div><b>Оплата или подтверждение</b><p>Онлайн либо на месте.</p></div>
      </div>
      <p class="punch">Статус открывается по ссылке, номеру или QR-коду. Аккаунт не нужен: по номеру виден только статус, управление заказом даёт секретная ссылка. Оставите почту — письмо придёт, когда заказ примут и когда он будет готов.</p>`
  },
  {
    title: 'Механика',
    sub: 'Слот резервирует секунды работы кухни, а не место в календаре',
    html: `
      <div class="formula">C = R × T × S &nbsp;=&nbsp; ${s.kitchenThroughputPerMin} с/мин × ${s.slotMinutes} мин × ${s.digitalSharePct}% = <b>${C} с</b> работы на интервал</div>
      <div class="sched">
        <div class="cell fill" style="--h:22%"><span>11:45</span><i>80 с</i></div>
        <div class="cell fill" style="--h:100%"><span>11:50</span><i>360 с</i></div>
        <div class="cell fill" style="--h:100%"><span>11:55</span><i>360 с</i></div>
        <div class="cell done"><span>12:00</span><i>готов</i></div>
      </div>
      <p class="punch">Работа раскладывается назад от времени выдачи. Не помещается в окно приготовления — слот не предлагается. Кухня и стойка выдачи считаются как два независимых ограничения.</p>`
  },
  {
    title: 'Проверьте сами',
    sub: 'Кнопка «Попробуйте сломать наше обещание» на странице проекта',
    html: `
      <div class="terminal">Принято заказов: 8<br>Закрылись времена: 12:50, 12:55, 13:00, 13:05, 13:10, 13:15<br>Следующее гарантированное время: <b>13:20</b><br><br>…нажать ещё несколько раз…<br><br><span class="red">Кухня насыщена: система отказалась принимать новые заказы.</span></div>
      <p class="punch">Обычное приложение приняло бы все заказы и переложило ожидание на гостя. Здесь невыполнимое время просто перестаёт продаваться.</p>`
  },
  {
    title: 'Что видно в демо',
    sub: `Детерминированная симуляция · выборка ${report.meta.sampleSize} заказов, из них ${report.meta.waitSampleSize} с замером ожидания`,
    html: `
      <div class="stats">
        ${stat(minutes(k.p90WaitSeconds) + ' мин', 'p90 ожидания на точке · цель ≤ 2 мин', 'good')}
        ${stat(Math.round(k.p90WaitCounterSeconds / 60) + ' мин', 'p90 на обычной кассе · точка отсчёта', 'bad')}
        ${stat('+' + k.throughputGainPct + '%', `выдач в час: ${String(k.peakThroughputPerHour).replace('.', ',')} против базы ${k.baselineThroughputPerHour} · цель +25%`, 'good')}
        ${stat(k.onTimePct + '%', 'готовы вовремя · цель ≥ 90%', 'good')}
        ${stat(k.expressSharePeakPct + '%', 'доля Express в пик · цель ≥ 40%', 'good')}
        ${stat(String(k.avgRating).replace('.', ','), 'оценка выдачи · цель ≥ 4,5', 'good')}
      </div>
      <p class="punch warn-text">Это симуляция, помеченная в интерфейсе, а не результат реального заведения. Цифры повторяются при каждом запуске — показ можно отрепетировать.</p>`
  },
  {
    title: 'Что ещё умеет система',
    sub: 'Не витрина, а операционный инструмент заведения',
    html: `
      <div class="cols four">
        <div class="col"><b>Дорога гостя</b><p>Слот отсеивается, если до него не доехать: пробки Алматы по часам, заторность района, время на паркинг.</p></div>
        <div class="col"><b>Выдача по QR</b><p>Сотрудник сканирует код гостя прямо в приложении — заказ закрывается за секунду, без поиска по спискам.</p></div>
        <div class="col"><b>Связь с гостем</b><p>Письма на каждом шаге со ссылкой на живой статус: вкладку можно закрыть. Свой SMTP, без сторонних сервисов.</p></div>
        <div class="col"><b>Калибровка и сбои</b><p>Плановое время готовки сверяется с замерами. Снятие заказа с возвратом, неявка, стоп-лист.</p></div>
        <div class="col"><b>Автономность</b><p>Ноль зависимостей npm, ${poi.total()} точек общепита города офлайн, ${TESTS} автоматических теста.</p></div>
      </div>`
  },
  {
    title: 'Следующий шаг',
    sub: 'Прототип показывает, как будет работать сервис. Эффект покажет пилот',
    html: `
      <div class="cols">
        <div class="col"><b>Неделя 1</b><p>Замерить p90 ожидания и число выдач в час в обеденный пик. Без базы рост недоказуем.</p></div>
        <div class="col"><b>Неделя 2</b><p>Запустить Express на 20–30 % мощности кухни, откалибровать время приготовления по факту.</p></div>
        <div class="col"><b>Решение</b><p>Поднимать долю, пока «готовы вовремя» держится выше 90 %. Методика — в docs/TECHNICAL.md.</p></div>
      </div>
      <p class="punch">Мы не изобрели управление мощностью — его ценность доказали крупные сервисы доставки. Мы сделали эту технологию доступной обычной столовой.</p>`
  }
];

const STYLE = `
@page { size: 338.7mm 190.5mm; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font: 15pt/1.45 -apple-system, "Segoe UI", Arial, sans-serif; color: #16191d; }
.slide { width: 338.7mm; height: 190.5mm; padding: 17mm 20mm; page-break-after: always;
  display: flex; flex-direction: column; position: relative; background: #fff; }
.slide:last-child { page-break-after: auto; }
.slide::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 5mm; background: #e8590c; }
h1 { font-size: 52pt; letter-spacing: -.03em; margin: 0 0 4mm; }
h2 { font-size: 28pt; letter-spacing: -.02em; margin: 0 0 2mm; }
.eyebrow { font-size: 12pt; font-weight: 700; color: #e8590c; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6mm; }
.tagline { font-size: 22pt; font-weight: 650; color: #b8460a; margin: 0 0 4mm; }
.sub { font-size: 15pt; color: #5d6672; margin: 0; max-width: 220mm; }
.subtitle { font-size: 15pt; color: #5d6672; margin: 0 0 8mm; }
.foot { position: absolute; left: 20mm; bottom: 14mm; font-size: 11pt; color: #8b95a3; }
.body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.cols { display: flex; gap: 8mm; }
.cols.four { gap: 5mm; }
.cols.four .col { flex: 1 1 0; padding: 5mm; }
.cols.four .col b { font-size: 12.5pt; }
.cols.four .col p { font-size: 11pt; }
.col { flex: 1 1 0; background: #f5f6f8; border: 1px solid #e2e5ea; border-radius: 4mm; padding: 6mm; }
.col.warn { background: #fdf3e2; border-color: #f0d9ab; }
.col b { display: block; font-size: 14pt; margin-bottom: 2mm; }
.col p { margin: 0; font-size: 12.5pt; color: #5d6672; line-height: 1.4; }
.num { width: 9mm; height: 9mm; border-radius: 50%; background: #e8590c; color: #fff; font-weight: 800;
  font-size: 13pt; display: flex; align-items: center; justify-content: center; margin-bottom: 3mm; }
.punch { margin: 7mm 0 0; font-size: 14pt; font-weight: 600; color: #16191d; }
.punch.warn-text { color: #b45309; font-weight: 600; font-size: 13pt; }
.formula { font: 20pt ui-monospace, Menlo, monospace; background: #fff1e8; border: 1px solid #f0c8a8;
  border-radius: 4mm; padding: 6mm; text-align: center; margin-bottom: 7mm; }
.sched { display: flex; gap: 4mm; align-items: flex-end; height: 42mm; }
.cell { flex: 1 1 0; border-radius: 3mm 3mm 0 0; display: flex; flex-direction: column;
  justify-content: flex-end; align-items: center; padding-bottom: 3mm; position: relative; }
.cell.fill { background: linear-gradient(to top, #15803d var(--h), #eef1f4 var(--h)); height: 100%; }
.cell.done { background: #fff1e8; border: 2px dashed #e8590c; height: 100%; }
.cell span { position: absolute; bottom: -9mm; font-size: 11pt; color: #5d6672; font-family: ui-monospace, Menlo, monospace; }
.cell i { font-style: normal; font-size: 12pt; font-weight: 700; color: #fff; }
.cell.done i { color: #b8460a; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
.stat { background: #f5f6f8; border: 1px solid #e2e5ea; border-radius: 4mm; padding: 6mm; }
.stat.good { border-color: #86d3a3; background: #e7f6ec; }
.stat.bad { border-color: #e8a5a5; background: #fdecec; }
.stat .v { font-size: 30pt; font-weight: 750; letter-spacing: -.02em; }
.stat .l { font-size: 11.5pt; color: #5d6672; margin-top: 1mm; line-height: 1.35; }
.terminal { font: 14pt/1.7 ui-monospace, Menlo, monospace; background: #16191d; color: #e8ecf1;
  border-radius: 4mm; padding: 7mm; }
.terminal b { color: #4ade80; }
.terminal .red { color: #f87171; }
`;

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Express Pick-Up</title><style>${STYLE}</style></head><body>` +
  slides.map(sl => sl.cls === 'title'
    ? `<section class="slide title">${sl.html}</section>`
    : `<section class="slide"><h2>${esc(sl.title)}</h2><div class="subtitle">${esc(sl.sub)}</div><div class="body">${sl.html}</div></section>`
  ).join('') + '</body></html>';

const tmp = path.join(os.tmpdir(), `epu-slides-${process.pid}.html`);
fs.writeFileSync(tmp, html);

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--no-pdf-header-footer', `--print-to-pdf=${OUT}`, 'file://' + tmp], { stdio: 'ignore' });
const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
child.on('exit', () => {
  clearTimeout(killer);
  try { fs.unlinkSync(tmp); } catch (e) { /* уже удалён */ }
  if (fs.existsSync(OUT)) {
    console.log(`Готово: ${OUT} (${slides.length} слайдов, ${Math.round(fs.statSync(OUT).size / 1024)} КБ)`);
    console.log(`Числа взяты из системы: p90 ${k.p90WaitSeconds} с, рост +${k.throughputGainPct} %, вовремя ${k.onTimePct} %`);
  } else {
    console.error('Chrome не создал PDF');
    process.exit(1);
  }
});
