(() => {
  const PRIORITY = ['RDDT','TSLA','SMH','PLTR','ORCL','NFLX','NEM','MU','MSFT','INTC','GOOGL','CRWV','CRCL','AXON','AVGO','AMZN','ABNB','AAPL'];
  const STORAGE_KEY = 'codex_schwab_watch_state_v1';
  const ALERT_KEY = 'codex_schwab_watch_alerts_v1';
  const SCAN_MS = 5000;
  const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

  let minimized = false;
  let alertsEnabled = false;
  let watchState = readJson(STORAGE_KEY, {});
  let alertState = readJson(ALERT_KEY, {});

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
    catch (_) { return fallback; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function money(value) {
    if (!Number.isFinite(value)) return 'n/a';
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function pct(value) {
    if (!Number.isFinite(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  }

  function parseNumber(text) {
    if (!text) return null;
    const n = parseFloat(String(text).replace(/[$,%+,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parseRowText(text, symbol) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat.includes(symbol)) return null;
    const after = flat.slice(flat.indexOf(symbol) + symbol.length);
    const priceToken = after.match(/\$\s*\d[\d,]*(?:\.\d+)?/)?.[0];
    const pctToken = after.match(/[+-]\s*\d+(?:\.\d+)?%/)?.[0];
    const price = parseNumber(priceToken);
    const dayPct = parseNumber(pctToken);
    if (!Number.isFinite(price) || !Number.isFinite(dayPct)) return null;
    return { symbol, price, dayPct, raw: flat, ts: Date.now() };
  }

  function scanRows() {
    const candidates = [
      ...document.querySelectorAll('tr'),
      ...document.querySelectorAll('[role="row"]'),
      ...document.querySelectorAll('[data-testid*="row" i]'),
    ];
    const bySymbol = new Map();
    for (const node of candidates) {
      const text = node.innerText || node.textContent || '';
      if (!text) continue;
      for (const sym of PRIORITY) {
        if (!new RegExp(`\\b${sym}\\b`).test(text)) continue;
        const parsed = parseRowText(text, sym);
        if (parsed) bySymbol.set(sym, parsed);
      }
    }
    return [...bySymbol.values()];
  }

  function updateSignal(q) {
    const prev = watchState[q.symbol] || {};
    const high = Math.max(prev.high || q.price, q.price);
    const low = Math.min(prev.low || q.price, q.price);
    const highPct = Math.max(prev.highPct ?? q.dayPct, q.dayPct);
    const lowPct = Math.min(prev.lowPct ?? q.dayPct, q.dayPct);
    const pulledBack = Boolean(prev.pulledBack)
      || q.price <= high * 0.9925
      || q.dayPct <= highPct - 1.0;
    const recovered = pulledBack
      && q.dayPct > 0
      && (q.price >= low * 1.0035 || q.dayPct >= lowPct + 0.75);
    const extended = q.dayPct >= 3 && q.price >= high * 0.995;

    let cls = 'neutral';
    let text = 'Watching';
    if (recovered) {
      cls = 'alert';
      text = 'Turning up after cool-off';
    } else if (extended) {
      cls = 'wait';
      text = 'Strong but extended';
    } else if (q.dayPct <= -1 || pulledBack) {
      cls = 'cool';
      text = 'Cooling off';
    } else if (q.dayPct >= 1) {
      cls = 'wait';
      text = 'Upward momentum';
    }

    const next = {
      ...q,
      high,
      low,
      highPct,
      lowPct,
      pulledBack,
      recovered,
      extended,
      cls,
      text,
      lastSeen: Date.now(),
    };
    watchState[q.symbol] = next;
    return next;
  }

  async function enableAlerts() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') {
      alertsEnabled = true;
      return true;
    }
    if (Notification.permission === 'denied') {
      alertsEnabled = false;
      return false;
    }
    const permission = await Notification.requestPermission();
    alertsEnabled = permission === 'granted';
    return alertsEnabled;
  }

  function maybeAlert(item) {
    if (!alertsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (item.cls !== 'alert') return;
    const last = alertState[item.symbol] || 0;
    if (Date.now() - last < ALERT_COOLDOWN_MS) return;
    alertState[item.symbol] = Date.now();
    writeJson(ALERT_KEY, alertState);
    try {
      new Notification(`${item.symbol}: turning up after cool-off`, {
        body: `${money(item.price)} | ${pct(item.dayPct)} | Schwab live watchlist`,
        tag: `codex-${item.symbol}`,
      });
    } catch (_) {}
  }

  function ensurePanel() {
    let panel = document.getElementById('codex-schwab-watch');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'codex-schwab-watch';
    panel.innerHTML = `
      <div class="csw-head">
        <div>
          <div class="csw-title">Priority Watch</div>
          <div class="csw-sub" id="csw-status">Reading Schwab watchlist...</div>
        </div>
        <div class="csw-actions">
          <button class="csw-btn" id="csw-alerts">Alerts</button>
          <button class="csw-btn" id="csw-min">Min</button>
        </div>
      </div>
      <div class="csw-body" id="csw-body"></div>
      <div class="csw-mini">Alerts trigger when a priority name pulls back, then turns up again on Schwab live quotes.</div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector('#csw-alerts').addEventListener('click', async () => {
      await enableAlerts();
      renderPanel(Object.values(watchState));
    });
    panel.querySelector('#csw-min').addEventListener('click', () => {
      minimized = !minimized;
      panel.querySelector('#csw-body').style.display = minimized ? 'none' : '';
      panel.querySelector('.csw-mini').style.display = minimized ? 'none' : '';
      panel.querySelector('#csw-min').textContent = minimized ? 'Open' : 'Min';
    });
    if ('Notification' in window && Notification.permission === 'granted') alertsEnabled = true;
    return panel;
  }

  function renderPanel(items) {
    const panel = ensurePanel();
    const body = panel.querySelector('#csw-body');
    const status = panel.querySelector('#csw-status');
    const alertBtn = panel.querySelector('#csw-alerts');
    alertBtn.classList.toggle('csw-on', alertsEnabled);
    alertBtn.textContent = alertsEnabled ? 'Alerts ON' : 'Alerts';

    const visible = PRIORITY
      .map(sym => items.find(i => i.symbol === sym) || watchState[sym])
      .filter(Boolean)
      .sort((a, b) => {
        const order = { alert: 0, wait: 1, cool: 2, neutral: 3 };
        return (order[a.cls] ?? 4) - (order[b.cls] ?? 4) || PRIORITY.indexOf(a.symbol) - PRIORITY.indexOf(b.symbol);
      });

    status.textContent = visible.length
      ? `Live: ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
      : 'No priority rows visible yet';

    if (!visible.length) {
      body.innerHTML = '<div class="csw-empty">Scroll your Schwab watchlist until priority names are visible. The overlay will read live rows as they appear.</div>';
      return;
    }

    body.innerHTML = visible.map(item => `
      <div class="csw-row csw-${item.cls || 'neutral'}">
        <div class="csw-sym">${item.symbol}</div>
        <div>
          <div class="csw-signal">${item.text || 'Watching'}</div>
          <div class="csw-time">High seen ${money(item.high)} | Low seen ${money(item.low)}</div>
        </div>
        <div>
          <div class="csw-price">${money(item.price)}</div>
          <div class="csw-pct ${item.dayPct >= 0 ? 'csw-up' : 'csw-down'}">${pct(item.dayPct)}</div>
        </div>
      </div>
    `).join('');
  }

  function tick() {
    const quotes = scanRows().map(updateSignal);
    quotes.forEach(maybeAlert);
    writeJson(STORAGE_KEY, watchState);
    renderPanel(quotes.length ? quotes : Object.values(watchState));
  }

  ensurePanel();
  tick();
  setInterval(tick, SCAN_MS);
})();
