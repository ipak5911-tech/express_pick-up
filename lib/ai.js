'use strict';
/**
 * Оценка времени приготовления новой позиции меню.
 *
 * Где здесь уместна языковая модель, а где нет:
 *
 *   НЕ уместна — считать ёмкость слотов и раскладывать работу по интервалам.
 *   Это детерминированная арифметика, и подменять её вероятностным ответом
 *   значит потерять главное свойство сервиса: обещание «готово к 12:30»
 *   должно опираться на проверяемую модель, а не на догадку.
 *
 *   Уместна — холодный старт. Когда заведение добавляет «Хачапури
 *   по-аджарски», замеров ещё нет, и человек вписывает время на глаз.
 *   Модель со знанием кухни даёт осмысленное первое приближение, которое
 *   затем уточняется калибровкой по фактическим замерам (lib/calibration.js).
 *
 * Провайдер переключается переменной окружения, ключи берутся оттуда же и
 * никогда не хранятся в репозитории. Без ключа работает локальная эвристика,
 * поэтому кнопка не ломается без сети.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

/** Минимальный разбор .env — заводить зависимость ради пяти строк не нужно. */
function loadEnvFile() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (e) { /* файла нет — работаем на переменных окружения или эвристике */ }
}
loadEnvFile();

const PROVIDERS = {
  gemini: {
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    label: 'Gemini'
  },
  grok: {
    key: () => process.env.XAI_API_KEY,
    model: () => process.env.XAI_MODEL || 'grok-2-latest',
    label: 'Grok'
  },
  ollama: {
    key: () => 'local',
    model: () => process.env.OLLAMA_MODEL || 'llama3.1',
    label: 'Llama (локально)'
  }
};

function activeProvider() {
  const name = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (name === 'off') return null;
  const p = PROVIDERS[name];
  if (!p || !p.key()) return null;
  return Object.assign({ name }, p);
}

function isEnabled() {
  return activeProvider() !== null;
}

// ---------- локальная эвристика ----------

// ---------- поиск похожих блюд ----------

/**
 * Поиск похожих блюд по всем заведениям — тот самый retrieval в RAG.
 *
 * Зачем он нужен здесь: категория слишком груба. «Горячее» вмещает и плов на
 * минуту, и бешбармак на пять, поэтому медиана по категории ошибалась в разы.
 * А вот «Плов с бараниной» и «Плов» — почти одно блюдо, и время у них близкое.
 *
 * Векторная база не нужна: блюд во всей сети меньше сотни, и лексическое
 * сходство работает лучше, чем выглядит. Ставить ради этого эмбеддинги и
 * отдельное хранилище значило бы усложнять систему без выигрыша.
 */
const STOP_WORDS = new Set(['с', 'и', 'в', 'на', 'по', 'из', 'для', 'без', 'мл', 'г', 'шт', 'порция']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t))
    .map(t => t.slice(0, 5));   // грубая нормализация окончаний: «плову» и «плова» совпадут
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const token of new Set(a)) if (setB.has(token)) hits++;
  return hits / Math.sqrt(a.length * b.length);
}

/**
 * Похожие блюда с их временем приготовления.
 * Измеренное значение всегда предпочтительнее заданного вручную: оно
 * подтверждено замерами на кухне.
 */
function findSimilar(item, venues, measuredByItemId = {}, limit = 5) {
  const query = tokenize(`${item.name} ${item.desc || ''}`);
  const rows = [];

  for (const v of venues) {
    for (const other of v.menu || []) {
      if (other.id === item.id) continue;
      // Совпадение слов обязательно: без него «похожими» становятся все напитки
      // подряд, и поиск вырождается в медиану по категории с чужим шумом.
      const lexical = similarity(query, tokenize(`${other.name} ${other.desc || ''}`));
      if (lexical <= 0.15) continue;
      const score = lexical + (other.category === item.category ? 0.25 : 0);
      const measured = measuredByItemId[other.id];
      rows.push({
        name: other.name,
        venue: v.name,
        category: other.category,
        seconds: measured != null ? measured : other.prepSeconds,
        measured: measured != null,
        score: Math.round(score * 100) / 100
      });
    }
  }

  return rows.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Запасная оценка без сети: взвешенное среднее по похожим блюдам.
 *
 * Сначала здесь были регулярки по названию, и это оказалось тупиком:
 * «ад(жар)ски» совпадало с ключом «жар», а описание «Готовится под заказ» —
 * с ключом «готов» и вдвое урезало время гриля. Затем была медиана по
 * категории, но категория оказалась слишком грубым признаком.
 */
const CATEGORY_FALLBACK = {
  'Напитки': 15, 'Кофе': 60, 'Выпечка': 60, 'Десерты': 20, 'Салаты': 45,
  'Супы': 70, 'Закуски': 130, 'Гарниры': 25, 'Горячее': 200, 'Пицца': 430,
  'Мангал': 520, 'Завтраки': 200, 'Шаурма': 190, 'Вок': 230
};

function medianOf(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function heuristicEstimate(item, venue, venues, measuredByItemId) {
  const menu = (venue && venue.menu) || [];
  const sameCategory = menu
    .filter(i => i.id !== item.id && i.category === item.category && Number.isFinite(i.prepSeconds))
    .map(i => i.prepSeconds);

  const median = medianOf(sameCategory);
  const similar = venues && venues.length
    ? findSimilar(item, venues, measuredByItemId || {}, 5)
    : [];

  if (median != null) {
    return {
      seconds: Math.max(10, Math.min(900, Math.round(median / 5) * 5)),
      reasoning: `Оценка без обращения к модели: медиана по категории «${item.category}» ` +
        `в этом меню (${sameCategory.length} поз.). Значение приблизительное — уточните замерами.`,
      source: 'category_median',
      providerLabel: 'локальный расчёт',
      similar
    };
  }

  return {
    seconds: CATEGORY_FALLBACK[item.category] || 120,
    reasoning: `В категории «${item.category || 'без категории'}» ещё нет позиций для сравнения, ` +
      'взято типичное значение. Уточните замерами.',
    source: 'category',
    providerLabel: 'локальный расчёт',
    similar
  };
}

// ---------- обращение к провайдеру ----------

function httpsJson(url, options, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(url, Object.assign({
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, options.headers || {})
    }, options), res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`провайдер ответил ${res.statusCode}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('не удалось разобрать ответ провайдера')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('таймаут обращения к провайдеру')); });
    req.write(body);
    req.end();
  });
}

function buildPrompt(venue, item, similar = []) {
  const examples = similar.length
    ? ['', 'Похожие блюда этой сети и их время (измеренные отмечены «замер»):',
       ...similar.map(r => `- ${r.name} (${r.venue}, ${r.category}): ${r.seconds} с${r.measured ? ' — замер' : ''}`),
       'Опирайся на эти значения: они отражают реальную кухню, а не общие представления.']
    : [];
  return [
    'Ты помогаешь заведению общепита оценить время приготовления блюда.',
    `Заведение: ${venue.name} (${venue.kind}).`,
    `Блюдо: «${item.name}», категория «${item.category}», описание: «${item.desc || 'нет'}».`,
    '',
    'Оцени, сколько СЕКУНД производственной работы повара требует одна порция:',
    'только активная работа на кухне, без ожидания гостя и без времени выдачи.',
    'Блюдо с витрины — 10–30 с, напиток из кофемашины — 40–90 с,',
    'горячее под заказ — 150–400 с, выпечка и мангал — 400–600 с.',
    ...examples,
    '',
    'Ответь строго в JSON: {"seconds": число, "reasoning": "одно предложение по-русски"}.'
  ].join('\n');
}

async function callGemini(provider, venue, item, similar) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model()}:generateContent?key=${provider.key()}`;
  const data = await httpsJson(url, {}, {
    contents: [{ parts: [{ text: buildPrompt(venue, item, similar) }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { seconds: { type: 'INTEGER' }, reasoning: { type: 'STRING' } },
        required: ['seconds', 'reasoning']
      }
    }
  });
  const text = data.candidates && data.candidates[0] &&
    data.candidates[0].content.parts.map(p => p.text).join('');
  return JSON.parse(text);
}

async function callGrok(provider, venue, item, similar) {
  const data = await httpsJson('https://api.x.ai/v1/chat/completions', {
    headers: { Authorization: 'Bearer ' + provider.key() }
  }, {
    model: provider.model(),
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: buildPrompt(venue, item, similar) }]
  });
  return JSON.parse(data.choices[0].message.content);
}

async function callOllama(provider, venue, item, similar) {
  const http = require('http');
  const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const body = JSON.stringify({
    model: provider.model(), stream: false, format: 'json',
    prompt: buildPrompt(venue, item, similar)
  });
  const data = await new Promise((resolve, reject) => {
    const req = http.request(host + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('таймаут Ollama')));
    req.write(body); req.end();
  });
  return JSON.parse(data.response);
}

/**
 * Оценка времени приготовления. Никогда не бросает: при любой проблеме
 * возвращается локальная эвристика, чтобы интерфейс не оставался пустым.
 */
async function estimatePrepSeconds(venue, item, context = {}) {
  const venues = context.venues || [venue];
  const measured = context.measuredByItemId || {};
  const similar = findSimilar(item, venues, measured, 5);

  const provider = activeProvider();
  if (!provider) {
    const local = heuristicEstimate(item, venue, venues, measured);
    local.similar = similar;
    return local;
  }

  try {
    let raw;
    if (provider.name === 'gemini') raw = await callGemini(provider, venue, item, similar);
    else if (provider.name === 'grok') raw = await callGrok(provider, venue, item, similar);
    else raw = await callOllama(provider, venue, item, similar);

    const seconds = Math.round(Number(raw.seconds));
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
      throw new Error('провайдер вернул неправдоподобное значение');
    }
    return {
      seconds,
      reasoning: String(raw.reasoning || '').slice(0, 300),
      source: provider.name,
      providerLabel: provider.label,
      similar
    };
  } catch (e) {
    const fallback = heuristicEstimate(item, venue, venues, measured);
    fallback.similar = similar;
    fallback.reasoning = `${provider.label} недоступен (${e.message}). ${fallback.reasoning}`;
    fallback.degraded = true;
    return fallback;
  }
}

module.exports = { estimatePrepSeconds, heuristicEstimate, findSimilar, isEnabled, activeProvider };
