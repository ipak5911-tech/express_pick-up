'use strict';
/**
 * Почта без зависимостей: минимальный SMTP-клиент поверх TLS и журнал писем.
 *
 * Зачем свой клиент. Прототип принципиально без npm-пакетов, а SMTP для
 * одного отправителя — это восемь команд по строке. Поддерживаются оба
 * распространённых режима: TLS сразу (порт 465, Gmail) и STARTTLS (587).
 *
 * Журнал (outbox). Каждое письмо — отправленное, неотправленное или только
 * записанное — попадает в базу. Это нужно по двум причинам: на демонстрации
 * без интернета видно, ЧТО ушло бы гостю; а при сбое SMTP сотрудник видит
 * ошибку в панели, а не гадает, почему гость не получил уведомление.
 *
 * Режимы (MAIL_TRANSPORT): smtp — реальная отправка; outbox — только журнал
 * (тесты, демо без сети); off — ничего. Без MAIL_USER/MAIL_PASS — outbox.
 */
const tls = require('tls');
const net = require('net');
const os = require('os');
const store = require('./store');
require('./env').loadEnvFile();

const OUTBOX_LIMIT = 200;
const SMTP_TIMEOUT_MS = 20000;

function config() {
  const user = process.env.MAIL_USER || '';
  const pass = process.env.MAIL_PASS || '';
  const port = Number(process.env.MAIL_PORT) || 465;
  let transport = (process.env.MAIL_TRANSPORT || '').toLowerCase();
  if (!transport) transport = user && pass ? 'smtp' : 'outbox';
  if (!['smtp', 'outbox', 'off'].includes(transport)) transport = 'outbox';
  if (transport === 'smtp' && !(user && pass)) transport = 'outbox';
  return {
    transport,
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port,
    secure: process.env.MAIL_SECURE ? process.env.MAIL_SECURE !== '0' : port === 465,
    user,
    pass,
    from: process.env.MAIL_FROM || (user ? `Express Pick-Up <${user}>` : 'Express Pick-Up <no-reply@localhost>')
  };
}

/** Публичное описание настройки — без пароля. */
function status() {
  const c = config();
  return { transport: c.transport, host: c.host, port: c.port, from: c.from, user: c.user };
}

// ---------- сборка письма ----------

const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || ''));

function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function addressOf(value) {
  const m = String(value).match(/<([^>]+)>/);
  return (m ? m[1] : String(value)).trim();
}

function base64Lines(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

/** RFC 5322 сообщение: текст + HTML, всё в UTF-8/base64, чтобы не думать о кодировках. */
function buildMessage({ from, to, subject, text, html, messageId }) {
  const boundary = 'epu-' + Math.random().toString(36).slice(2);
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@express-pickup>`,
    'MIME-Version: 1.0',
    'X-Mailer: Express Pick-Up',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    ''
  ];
  return lines.join('\r\n');
}

// ---------- SMTP ----------

class SmtpError extends Error {
  constructor(code, reply, command) {
    super(`SMTP ${code}: ${reply.split('\n')[0]}`);
    this.code = code;
    this.command = command;
  }
}

/**
 * Одно соединение — одно письмо. Ответы SMTP многострочные («250-…» до
 * «250 »), поэтому читаем до строки с пробелом после кода.
 */
function smtpSend(cfg, envelope, raw) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let buffer = '';
    let waiting = null;
    let done = false;
    const hostname = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';

    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (socket) socket.end(); } catch (e) { /* уже закрыт */ }
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP: время ожидания истекло')), SMTP_TIMEOUT_MS);

    const onData = chunk => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      const complete = lines.findIndex(l => /^\d{3} /.test(l));
      if (complete < 0) return;
      const reply = lines.slice(0, complete + 1).join('\n');
      buffer = lines.slice(complete + 1).join('\r\n');
      const handler = waiting;
      waiting = null;
      if (handler) handler([Number(reply.slice(0, 3)), reply]);
    };
    const attach = s => {
      socket = s;
      s.setEncoding('utf8');
      s.on('data', onData);
      s.on('error', finish);
      s.on('close', () => finish(new Error('SMTP: соединение закрыто')));
    };
    const reply = () => new Promise(res => { waiting = res; });
    const send = text => { socket.write(text + '\r\n'); return reply(); };
    const expect = ([code, text], ok, label) => {
      if (!ok.includes(code)) throw new SmtpError(code, text, label);
      return text;
    };

    const talk = async () => {
      expect(await reply(), [220], 'greeting');
      let ehlo = expect(await send(`EHLO ${hostname}`), [250], 'EHLO');
      if (!cfg.secure) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('SMTP: сервер не поддерживает STARTTLS');
        expect(await send('STARTTLS'), [220], 'STARTTLS');
        await new Promise((res, rej) => {
          const plain = socket;
          plain.removeAllListeners('data');
          plain.removeAllListeners('close');
          const secure = tls.connect({ socket: plain, servername: cfg.host }, res);
          secure.once('error', rej);
          attach(secure);
        });
        ehlo = expect(await send(`EHLO ${hostname}`), [250], 'EHLO');
      }
      const token = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`).toString('base64');
      expect(await send(`AUTH PLAIN ${token}`), [235], 'AUTH');
      expect(await send(`MAIL FROM:<${envelope.from}>`), [250], 'MAIL FROM');
      expect(await send(`RCPT TO:<${envelope.to}>`), [250, 251], 'RCPT TO');
      expect(await send('DATA'), [354], 'DATA');
      // точка в начале строки означает конец письма, поэтому её удваивают
      expect(await send(raw.replace(/\r\n\./g, '\r\n..') + '\r\n.'), [250], 'BODY');
      socket.write('QUIT\r\n');
      finish();
    };

    try {
      attach(cfg.secure
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : net.connect({ host: cfg.host, port: cfg.port }));
      talk().catch(finish);
    } catch (e) {
      finish(e);
    }
  });
}

// ---------- журнал ----------

function outbox() {
  const db = store.load();
  if (!Array.isArray(db.mail)) db.mail = [];
  return db.mail;
}

function record(entry) {
  const list = outbox();
  list.unshift(entry);
  if (list.length > OUTBOX_LIMIT) list.length = OUTBOX_LIMIT;
  store.save({ type: 'mail', venueId: entry.venueId || null, mailId: entry.id });
  return entry;
}

function listFor(venueId, limit = 50) {
  return outbox()
    .filter(m => !venueId || m.venueId === venueId)
    .slice(0, limit)
    .map(m => ({
      id: m.id, at: m.at, to: m.to, subject: m.subject, event: m.event, status: m.status,
      error: m.error || null, orderCode: m.orderCode || null, transport: m.transport, preview: m.preview
    }));
}

// Письма уходят по одному: SMTP-серверы не любят десяток параллельных
// соединений с одного адреса, а очередь в памяти для прототипа достаточна.
let chain = Promise.resolve();

/**
 * Отправить письмо и записать результат в журнал. Возвращает запись журнала;
 * никогда не бросает — сбой почты не должен ломать заказ.
 */
function send({ to, subject, text, html, event = 'custom', venueId = null, orderId = null, orderCode = null }) {
  const cfg = config();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id, at: new Date().toISOString(), to, subject, event, venueId, orderId, orderCode,
    transport: cfg.transport, status: 'queued', error: null,
    preview: String(text || '').slice(0, 600)
  };
  if (!isEmail(to)) {
    entry.status = 'failed';
    entry.error = 'bad_address';
    return Promise.resolve(record(entry));
  }
  if (cfg.transport === 'off') {
    entry.status = 'skipped';
    return Promise.resolve(record(entry));
  }
  if (cfg.transport === 'outbox') {
    entry.status = 'logged';
    return Promise.resolve(record(entry));
  }
  const raw = buildMessage({ from: cfg.from, to, subject, text, html, messageId: id });
  const job = chain.then(async () => {
    try {
      await smtpSend(cfg, { from: addressOf(cfg.from), to }, raw);
      entry.status = 'sent';
    } catch (e) {
      entry.status = 'failed';
      entry.error = e.message;
      console.error(`Почта: письмо ${to} не ушло — ${e.message}`);
    }
    return record(entry);
  });
  chain = job.catch(() => {});
  return job;
}

module.exports = { config, status, isEmail, buildMessage, send, listFor, smtpSend };
