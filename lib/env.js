'use strict';
/**
 * Загрузка .env — секреты (ключи ИИ, пароль почты) лежат в файле, которого
 * нет в репозитории. Заводить зависимость ради пятнадцати строк не нужно.
 * Переменные, уже заданные в окружении, файлом не перебиваются.
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
let loaded = false;

function loadEnvFile() {
  if (loaded) return;
  loaded = true;
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
  } catch (e) { /* файла нет — работаем на переменных окружения */ }
}

module.exports = { loadEnvFile, ENV_FILE };
