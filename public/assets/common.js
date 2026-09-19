/* Express Pick-Up — общие утилиты интерфейса */
(function () {
  const t = (k, p) => window.I18N.t(k, p);

  // Часовой пояс заведения: сервер сообщает своё смещение, и все подписи времени
  // (слоты, «выдача в 12:35», кухонная очередь) считаются в нём, а не в поясе устройства.
  let serverOffsetMinutes = new Date().getTimezoneOffset();

  // ---------- сеть ----------
  async function api(path, opts) {
    const options = Object.assign({ headers: {} }, opts || {});
    if (options.body && typeof options.body !== 'string') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(path, options);
    } catch (e) {
      throw { error: 'offline', message: t('common.offline') };
    }
    const tz = res.headers && res.headers.get && res.headers.get('X-Server-Tz-Offset');
    if (tz != null && tz !== '' && Number.isFinite(Number(tz))) serverOffsetMinutes = Number(tz);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) throw (data || { error: 'http_' + res.status, message: t('common.error') });
    return data;
  }

  // ---------- форматирование ----------
  const money = n => new Intl.NumberFormat(window.I18N.lang === 'en' ? 'en-US' : 'ru-RU').format(Math.round(n)) + ' ₽';
  function hhmm(iso) {
    if (!iso) return '\u2014';
    const shifted = new Date(new Date(iso).getTime() - serverOffsetMinutes * 60000);
    return shifted.toISOString().slice(11, 16);
  }
  const minutesOf = sec => Math.max(1, Math.round(sec / 60));

  function mmss(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function waitLabel(sec) {
    if (sec == null) return '—';
    if (sec < 90) return `${Math.round(sec)} ${t('common.sec')}`;
    return `${(sec / 60).toFixed(1).replace('.', ',')} ${t('common.min')}`;
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);

  // ---------- DOM ----------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of [].concat(children || [])) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  // ---------- уведомления ----------
  let toastHost = null;
  function toast(message, isError) {
    if (!toastHost) {
      toastHost = el('div', { class: 'toast-host' });
      document.body.appendChild(toastHost);
    }
    const node = el('div', { class: 'toast' + (isError ? ' err' : ''), text: message });
    toastHost.appendChild(node);
    setTimeout(() => node.remove(), 3200);
  }

  // ---------- локальное хранилище ----------
  const mem = {};
  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('epu.' + key);
        return raw ? JSON.parse(raw) : (key in mem ? mem[key] : fallback);
      } catch (e) { return key in mem ? mem[key] : fallback; }
    },
    set(key, value) {
      mem[key] = value;
      try { localStorage.setItem('epu.' + key, JSON.stringify(value)); } catch (e) { /* приватный режим */ }
    },
    del(key) {
      delete mem[key];
      try { localStorage.removeItem('epu.' + key); } catch (e) { /* приватный режим */ }
    }
  };

  // ---------- шапка ----------
  function mountHeader(active) {
    const host = document.getElementById('topbar');
    if (!host) return;
    const links = [
      { href: '/', key: 'nav.guest', id: 'guest' },
      { href: '/kitchen', key: 'nav.kitchen', id: 'kitchen' },
      { href: '/pickup', key: 'nav.pickup', id: 'pickup' },
      { href: '/admin', key: 'nav.admin', id: 'admin' }
    ];
    host.className = 'topbar';
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'topbar-inner' }, [
      el('a', { class: 'logo', href: '/' }, [
        el('span', { class: 'logo-mark', text: 'E' }),
        el('span', {}, [
          el('span', { 'data-i18n': 'app.name' }),
          el('small', { 'data-i18n': 'app.tagline' })
        ])
      ]),
      el('span', { class: 'spacer' }),
      el('nav', { class: 'navlinks' }, links.map(l =>
        el('a', { href: l.href, class: l.id === active ? 'active' : '', 'data-i18n': l.key })
      )),
      el('div', { class: 'lang-switch' }, ['ru', 'en'].map(code =>
        el('button', {
          type: 'button',
          text: code.toUpperCase(),
          'aria-pressed': window.I18N.lang === code,
          onclick: () => {
            window.I18N.setLang(code);
            host.querySelectorAll('.lang-switch button').forEach(b =>
              b.setAttribute('aria-pressed', b.textContent.toLowerCase() === code));
          }
        })
      ))
    ]));
    window.I18N.apply(host);
  }

  // ---------- живые обновления ----------
  function live(venueId, onEvent) {
    let source = null;
    let closed = false;
    let retry = null;

    function connect() {
      if (closed) return;
      const qs = venueId ? '?venue=' + encodeURIComponent(venueId) : '';
      source = new EventSource('/api/stream' + qs);
      source.onmessage = ev => {
        try { onEvent(JSON.parse(ev.data)); } catch (e) { /* пропускаем */ }
      };
      source.onerror = () => {
        source.close();
        if (!closed) retry = setTimeout(connect, 2500);
      };
    }
    connect();
    return {
      close() { closed = true; if (retry) clearTimeout(retry); if (source) source.close(); },
      update(next) { venueId = next; if (source) source.close(); if (retry) clearTimeout(retry); connect(); }
    };
  }

  // ---------- прочее ----------
  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function loadClass(pct) {
    return pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  }

  window.EPU = { api, money, hhmm, venueNow: () => new Date(Date.now() - serverOffsetMinutes * 60000), mmss, minutesOf, waitLabel, esc, el, toast, storage, mountHeader, live, qs, debounce, loadClass, t };
})();
