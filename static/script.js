const marketList = document.getElementById('marketList');
const historyList = document.getElementById('historyList');
const historyCount = document.getElementById('historyCount');
const selectedSymbolEl = document.getElementById('selectedSymbol');
const selectedInfoEl = document.getElementById('selectedInfo');
const selectedScoreEl = document.getElementById('selectedScore');
const signalSummary = document.getElementById('signalSummary');
const marketInput = document.getElementById('marketInput');
const addMarketButton = document.getElementById('addMarketButton');
const silenceButton = document.getElementById('silenceButton');
const telegramTestButton = document.getElementById('telegramTestButton');
const telegramStatusEl = document.getElementById('telegramStatus');
const soundTestButton = document.getElementById('soundTestButton');
const operativeTab = document.getElementById('operativeTab');
const statsTab = document.getElementById('statsTab');
const operativeView = document.getElementById('operativeView');
const statsView = document.getElementById('statsView');
const refreshStatsButton = document.getElementById('refreshStatsButton');
const statsSummary = document.getElementById('statsSummary');
const marketStats = document.getElementById('marketStats');
const confidenceStats = document.getElementById('confidenceStats');
const discardStats = document.getElementById('discardStats');
const financialStats = document.getElementById('financialStats');

let markets = [];
let selectedSymbol = null;
let muteAlerts = false;
let chart;
let candleSeries;
let emaSeries;
let upperSeries;
let lowerSeries;
let markerApi;
let searchDebounce;
let websocketPrimed = false;
let lastSignals = [];
const playedSignalKeys = new Set();
const expandedIgnore = new Set();
const expandedOperate = new Set();
const discardReasons = [
  'Mercado lateral',
  'Tendencia contraria',
  'Resistencia',
  'Soporte',
  'Volatilidad',
  'No estaba operando',
  'Otro',
];

async function playAlertTone() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    if (context.state === 'suspended') {
      await context.resume();
    }
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, context.currentTime);
    master.gain.exponentialRampToValueAtTime(0.045, context.currentTime + 0.04);
    master.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
    master.connect(context.destination);

    [
      { frequency: 330, start: 0, duration: 0.24 },
      { frequency: 440, start: 0.18, duration: 0.28 },
    ].forEach((note) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;
      gain.gain.setValueAtTime(0.0001, context.currentTime + note.start);
      gain.gain.exponentialRampToValueAtTime(0.6, context.currentTime + note.start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + note.start + note.duration);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(context.currentTime + note.start);
      oscillator.stop(context.currentTime + note.start + note.duration + 0.04);
    });

    setTimeout(() => {
      context.close().catch(() => {});
    }, 750);
    return true;
  } catch (error) {
    console.warn('No se pudo reproducir el sonido de alerta', error);
    return false;
  }
}

function signalKey(market) {
  if (!market || market.signal_status !== 'confirmed' || market.direction === 'none') return '';
  return `${market.symbol}:${market.direction}:${market.signal_time || ''}:${market.score}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMoney(value) {
  const number = Number(value || 0);
  return number.toLocaleString('es-CO', { maximumFractionDigits: 2 });
}

function formatPercent(value) {
  const number = Number(value || 0);
  return `${number.toFixed(2)}%`;
}

function signalDirectionClass(item) {
  return item.direction_key || String(item.direction || item.direccion || '').toLowerCase();
}

async function patchSignal(signalId, payload) {
  const res = await fetch(`/api/signals/${encodeURIComponent(signalId)}/decision`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text());
  const updated = await res.json();
  lastSignals = lastSignals.map((signal) => signal.signal_id === signalId ? updated : signal);
  renderHistory(lastSignals);
  fetchStats();
}

function createSeries(type, options) {
  if (!chart || typeof LightweightCharts === 'undefined') return null;
  const legacyName = type === 'candles' ? 'addCandlestickSeries' : 'addLineSeries';
  const v5Type = type === 'candles' ? LightweightCharts.CandlestickSeries : LightweightCharts.LineSeries;
  if (typeof chart[legacyName] === 'function') return chart[legacyName](options);
  if (typeof chart.addSeries === 'function' && v5Type) return chart.addSeries(v5Type, options);
  return null;
}

function createChart() {
  const container = document.getElementById('chart');
  if (!container) return;
  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = '<div class="chart-empty">Error: no se cargó la librería de gráficos.</div>';
    return;
  }

  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight || 520,
    autoSize: true,
    layout: {
      background: {
        type: LightweightCharts.ColorType?.Solid || 'solid',
        color: '#101827',
      },
      textColor: '#d9e4f2',
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(148, 163, 184, 0.12)' },
      horzLines: { color: 'rgba(148, 163, 184, 0.12)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      scaleMargins: { top: 0.08, bottom: 0.12 },
    },
    timeScale: {
      borderColor: 'rgba(148, 163, 184, 0.18)',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode?.Normal ?? 0,
    },
  });

  candleSeries = createSeries('candles', {
    upColor: '#2ddf8f',
    downColor: '#ff5c7c',
    borderVisible: false,
    wickUpColor: '#2ddf8f',
    wickDownColor: '#ff5c7c',
  });
  emaSeries = createSeries('line', { color: '#63b3ff', lineWidth: 2, priceLineVisible: false });
  upperSeries = createSeries('line', { color: '#f2b84b', lineWidth: 1, priceLineVisible: false });
  lowerSeries = createSeries('line', { color: '#f2b84b', lineWidth: 1, priceLineVisible: false });

  if (!candleSeries || !emaSeries || !upperSeries || !lowerSeries) {
    container.innerHTML = '<div class="chart-empty">Error: la librería de gráficos no admite la creación de series.</div>';
    return;
  }
  if (typeof LightweightCharts.createSeriesMarkers === 'function') {
    markerApi = LightweightCharts.createSeriesMarkers(candleSeries, []);
  }
}

function resizeChart() {
  const container = document.getElementById('chart');
  if (!chart || !container) return;
  chart.applyOptions({ width: container.clientWidth, height: container.clientHeight || 520 });
}

window.addEventListener('resize', resizeChart);

async function fetchMarkets(searchTerm = '') {
  const query = searchTerm.trim();
  const params = new URLSearchParams();
  if (query) {
    params.set('search', query);
    params.set('include_inactive', 'true');
  }
  const url = params.toString() ? `/api/markets?${params}` : '/api/markets';
  const res = await fetch(url, { cache: 'no-store' });
  markets = await res.json();
  const selectedVisible = markets.some((market) => market.symbol === selectedSymbol);
  if (!query && (!selectedSymbol || !selectedVisible)) {
    selectedSymbol = markets[0]?.symbol || null;
  } else if (!selectedSymbol && markets.length) {
    selectedSymbol = markets[0].symbol;
  }
  renderMarketList();
  if (selectedSymbol && (!query || selectedVisible)) await renderSelected(selectedSymbol);
}

async function fetchCandles(symbol) {
  const res = await fetch(`/api/candles/${encodeURIComponent(symbol)}`, { cache: 'no-store' });
  if (!res.ok) return [];
  try {
    return await res.json();
  } catch {
    return [];
  }
}

function setSeriesData(series, data) {
  if (series && typeof series.setData === 'function') series.setData(data);
}

function setMarkers(markers) {
  if (candleSeries && typeof candleSeries.setMarkers === 'function') {
    candleSeries.setMarkers(markers);
  } else if (markerApi && typeof markerApi.setMarkers === 'function') {
    markerApi.setMarkers(markers);
  }
}

function statusText(market) {
  if (!market) return '';
  if (market.last_error) return market.last_error;
  return market.data_status || 'Sin datos';
}

function signalStatusText(market) {
  if (!market) return 'Esperando análisis';
  if (market.signal_status === 'confirmed') return 'Entrada confirmada';
  if (market.signal_status === 'possible_reversal') return 'Posible reversa en observación';
  return 'Sin confirmación suficiente';
}

async function renderSelected(symbol, marketData = null) {
  selectedSymbol = symbol;
  const market = markets.find((m) => m.symbol === symbol) || marketData;
  selectedSymbolEl.textContent = symbol;
  selectedScoreEl.textContent = market ? market.score : '0';
  selectedScoreEl.dataset.direction = market?.direction || 'none';
  selectedInfoEl.textContent = market
    ? `Última puntuación ${market.score} · ${market.direction.toUpperCase()} · ${signalStatusText(market)} · ${market.data_source || 'Fuente no definida'}`
    : 'Esperando datos';

  const candles = marketData?.candles ?? await fetchCandles(symbol);
  if (!Array.isArray(candles) || candles.length === 0) {
    setSeriesData(candleSeries, []);
    setSeriesData(emaSeries, []);
    setSeriesData(upperSeries, []);
    setSeriesData(lowerSeries, []);
    setMarkers([]);
    signalSummary.innerHTML = `<strong>No hay velas para ${symbol}</strong><span>${statusText(market)}</span>`;
    chart?.timeScale().fitContent?.();
    return;
  }

  const candleData = candles
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
    .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
  setSeriesData(candleSeries, candleData);

  const closeData = candles.map((c) => ({ time: c.time, value: c.close }));
  setSeriesData(emaSeries, computeEMA(closeData, 21));
  const bands = computeBBands(closeData, 20);
  setSeriesData(upperSeries, bands.upper);
  setSeriesData(lowerSeries, bands.lower);

  const markers = [];
  if (market?.tags?.length && market.direction !== 'none') {
    const isCall = market.direction === 'call';
    markers.push({
      time: market.signal_time || candles[candles.length - 2]?.time || candles[candles.length - 1].time,
      position: isCall ? 'belowBar' : 'aboveBar',
      color: isCall ? '#2ddf8f' : '#ff5c7c',
      shape: isCall ? 'arrowUp' : 'arrowDown',
      text: market.direction.toUpperCase(),
    });
  }
  setMarkers(markers);
  chart?.timeScale().fitContent?.();

  const tagLine = market?.tags?.length ? market.tags.join(' · ') : signalStatusText(market);
  const analysis = market?.analysis || {};
  const telegramLine = market?.last_telegram_status ? `<span>${market.last_telegram_status}</span>` : '';
  signalSummary.innerHTML = `
    <strong>${tagLine}</strong>
    <span>${market.data_source || 'Fuente no definida'} · ${statusText(market)} · ${candles.length} velas cargadas</span>
    <span>Fuerza: ${analysis.strength || 'Sin evaluar'} · Continuidad: ${analysis.continuity || 'Sin evaluar'} · Cansancio: ${analysis.fatigue || 'Sin evaluar'} · Confianza: ${analysis.confidence || 'Sin evaluar'}</span>
    ${telegramLine}
  `;
}

function computeEMA(values, period) {
  const ema = [];
  if (values.length < period) return ema;
  let prev = values.slice(0, period).reduce((sum, item) => sum + item.value, 0) / period;
  ema.push({ time: values[period - 1].time, value: prev });
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i].value * k + prev * (1 - k);
    ema.push({ time: values[i].time, value: prev });
  }
  return ema;
}

function computeBBands(values, period = 20) {
  const upper = [];
  const lower = [];
  if (values.length < period) return { upper, lower };
  for (let i = 0; i <= values.length - period; i += 1) {
    const slice = values.slice(i, i + period);
    const sma = slice.reduce((sum, item) => sum + item.value, 0) / period;
    const variance = slice.reduce((sum, item) => sum + (item.value - sma) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const time = values[i + period - 1].time;
    upper.push({ time, value: sma + 2 * sd });
    lower.push({ time, value: sma - 2 * sd });
  }
  return { upper, lower };
}

function renderMarketList() {
  marketList.innerHTML = '';
  markets.forEach((market) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'market-card' + (market.symbol === selectedSymbol ? ' active' : '');
    if (market.score >= 4) card.classList.add('alerting');
    if (!market.active) card.classList.add('disabled');
    card.onclick = () => renderSelected(market.symbol);

    const status = market.last_error ? 'error' : market.candles?.length ? 'live' : 'waiting';
    card.innerHTML = `
      <span class="market-top">
        <strong>${market.symbol}</strong>
        <span class="market-score ${market.direction}">${market.score}</span>
      </span>
      <span class="market-meta">${market.category.toUpperCase()} · ${signalStatusText(market)}</span>
      <span class="market-status ${status}">${market.data_source || 'Fuente no definida'} · ${market.last_error || market.data_status || 'Sin datos'}</span>
      <span class="market-tags">${market.tags?.length ? market.tags.join(' · ') : 'Sin confirmación suficiente'}</span>
    `;

    const actions = document.createElement('span');
    actions.className = 'market-actions';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = market.active ? 'Desactivar' : 'Activar';
    toggleBtn.onclick = (event) => {
      event.stopPropagation();
      toggleMarket(market.symbol);
    };
    actions.appendChild(toggleBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete';
    deleteBtn.textContent = 'Eliminar';
    deleteBtn.onclick = (event) => {
      event.stopPropagation();
      deleteMarket(market.symbol);
    };
    actions.appendChild(deleteBtn);
    card.appendChild(actions);
    marketList.appendChild(card);
  });
}

async function toggleMarket(symbol) {
  const res = await fetch(`/api/markets/${encodeURIComponent(symbol)}/toggle`, { method: 'PATCH' });
  if (!res.ok) console.error('Toggle failed', await res.text());
  await fetchMarkets(marketInput.value.trim());
}

async function deleteMarket(symbol) {
  if (!confirm(`Eliminar mercado ${symbol}?`)) return;
  const res = await fetch(`/api/markets/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  if (!res.ok) console.error('Delete failed', await res.text());
  await fetchMarkets(marketInput.value.trim());
}

addMarketButton.addEventListener('click', async () => {
  const value = marketInput.value.trim();
  if (!value) return;
  const res = await fetch('/api/markets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: value }),
  });
  if (!res.ok) {
    alert(`Error al agregar mercado: ${await res.text()}`);
  } else {
    const created = await res.json();
    selectedSymbol = created.symbol;
    marketInput.value = '';
    await fetchMarkets('');
  }
});

marketInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    fetchMarkets(marketInput.value.trim());
  }, 250);
});

marketInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addMarketButton.click();
});

silenceButton.addEventListener('click', () => {
  muteAlerts = !muteAlerts;
  silenceButton.textContent = muteAlerts ? 'Alertas silenciadas' : 'Silenciar alertas';
  silenceButton.classList.toggle('muted', muteAlerts);
});

soundTestButton.addEventListener('click', async () => {
  soundTestButton.disabled = true;
  await playAlertTone();
  setTimeout(() => {
    soundTestButton.disabled = false;
  }, 700);
});

telegramTestButton.addEventListener('click', async () => {
  telegramStatusEl.textContent = 'Enviando prueba...';
  telegramTestButton.disabled = true;
  try {
    const res = await fetch('/api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: selectedSymbol || 'TEST' }),
    });
    const data = await res.json();
    telegramStatusEl.textContent = data.ok ? 'Prueba enviada a Telegram' : `Telegram: ${data.error || 'falló el envío'}`;
  } catch (error) {
    telegramStatusEl.textContent = 'Telegram: error de red';
  } finally {
    telegramTestButton.disabled = false;
  }
});

function renderHistoryLegacy(signals) {
  historyList.innerHTML = '';
  signals.slice().reverse().forEach((item) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <span class="history-time">${item.time}</span>
      <span class="history-main">
        <strong>${item.symbol}</strong>
        <span>${item.tags?.length ? item.tags.join(' · ') : 'Sin tags'}</span>
      </span>
      <span class="pill ${item.direction.toLowerCase()}">${item.direction}</span>
      <span class="history-score">${item.score}</span>
    `;
    historyList.appendChild(row);
  });
}

function renderHistory(signals) {
  lastSignals = Array.isArray(signals) ? signals : [];
  historyList.innerHTML = '';
  if (historyCount) historyCount.textContent = String(lastSignals.length);
  lastSignals.slice().reverse().forEach((item) => {
    const signalId = item.signal_id;
    const decision = item.decision_humana || 'PENDIENTE';
    const direction = item.direccion || item.direction || '';
    const tags = item.tags?.length ? item.tags.join(' - ') : 'Sin tags';
    const confidence = item.confianza || item.confidence || '';
    const showIgnore = expandedIgnore.has(signalId) && decision === 'PENDIENTE';
    const showOperate = expandedOperate.has(signalId) && (decision === 'PENDIENTE' || decision === 'OPERAR') && !item.resultado;
    const reasonOptions = discardReasons.map((reason) => (
      `<option value="${escapeHtml(reason)}"${item.motivo_descarte === reason ? ' selected' : ''}>${escapeHtml(reason)}</option>`
    )).join('');
    const row = document.createElement('div');
    row.className = 'history-item';
    row.dataset.signalId = signalId;
    row.innerHTML = `
      <span class="history-time">${escapeHtml(item.time)}</span>
      <span class="history-main">
        <strong>${escapeHtml(item.mercado || item.symbol)} <small>${escapeHtml(signalId)}</small></strong>
        <span>${escapeHtml(tags)}</span>
        <span>Confianza: ${escapeHtml(confidence)} - Estado: ${escapeHtml(decision)}</span>
      </span>
      <span class="pill ${signalDirectionClass(item)}">${escapeHtml(direction)}</span>
      <span class="history-score">${escapeHtml(item.score)}</span>
      <div class="history-actions">
        ${decision === 'PENDIENTE' ? `
          <button type="button" data-action="operate">OPERAR</button>
          <button type="button" data-action="ignore">IGNORAR</button>
        ` : ''}
        ${decision === 'IGNORAR' ? `<span class="decision-note">Ignorada: ${escapeHtml(item.motivo_descarte || 'Otro')}</span>` : ''}
        ${decision === 'OPERAR' && !item.resultado ? `<span class="decision-note">Operada - pendiente resultado</span>` : ''}
        ${item.resultado ? `<span class="decision-note ${item.resultado.toLowerCase()}">${escapeHtml(item.resultado)} - Profit ${formatMoney(item.profit)}</span>` : ''}
      </div>
      ${showIgnore ? `
        <div class="inline-editor">
          <select data-field="reason">${reasonOptions}</select>
          <button type="button" data-action="save-ignore">Guardar</button>
        </div>
      ` : ''}
      ${showOperate ? `
        <div class="inline-editor trade-editor">
          <input data-field="amount" inputmode="decimal" placeholder="Monto" value="${escapeHtml(item.monto_total || '')}" />
          <input data-field="payout" inputmode="decimal" placeholder="Payout %" value="${escapeHtml(item.payout || '')}" />
          <button type="button" data-action="win">WIN</button>
          <button type="button" data-action="loss">LOSS</button>
        </div>
      ` : ''}
    `;
    historyList.appendChild(row);
  });
}

async function fetchHistory() {
  const res = await fetch('/api/signals', { cache: 'no-store' });
  if (res.ok) renderHistory(await res.json());
}

historyList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.history-item');
  const signalId = row?.dataset.signalId;
  if (!signalId) return;
  const action = button.dataset.action;
  try {
    if (action === 'ignore') {
      expandedIgnore.add(signalId);
      expandedOperate.delete(signalId);
      renderHistory(lastSignals);
    } else if (action === 'operate') {
      expandedOperate.add(signalId);
      expandedIgnore.delete(signalId);
      await patchSignal(signalId, { decision_humana: 'OPERAR' });
      expandedOperate.add(signalId);
      renderHistory(lastSignals);
    } else if (action === 'save-ignore') {
      const reason = row.querySelector('[data-field="reason"]')?.value || 'Otro';
      await patchSignal(signalId, { decision_humana: 'IGNORAR', motivo_descarte: reason });
      expandedIgnore.delete(signalId);
    } else if (action === 'win' || action === 'loss') {
      const amount = row.querySelector('[data-field="amount"]')?.value;
      const payout = row.querySelector('[data-field="payout"]')?.value;
      await patchSignal(signalId, {
        resultado: action === 'win' ? 'WIN' : 'LOSS',
        monto_total: amount,
        payout,
      });
      expandedOperate.delete(signalId);
    }
  } catch (error) {
    console.error('No se pudo actualizar la senal', error);
  }
});

function statsCard(label, value) {
  return `
    <div class="stats-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderStatsTable(headers, rows) {
  return `
    <table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `;
}

async function fetchStats() {
  if (!statsSummary) return;
  const res = await fetch('/api/stats', { cache: 'no-store' });
  if (!res.ok) return;
  const stats = await res.json();
  const summary = stats.summary || {};
  const financial = stats.financial || {};
  statsSummary.innerHTML = [
    statsCard('Senales generadas', summary.generated ?? 0),
    statsCard('Senales operadas', summary.operated ?? 0),
    statsCard('Senales ignoradas', summary.ignored ?? 0),
    statsCard('Porcentaje operado', formatPercent(summary.operated_percentage)),
    statsCard('Porcentaje ignorado', formatPercent(summary.ignored_percentage)),
  ].join('');
  marketStats.innerHTML = renderStatsTable(
    ['Mercado', 'Generadas', 'Operadas', 'Win Rate', 'Profit'],
    (stats.by_market || []).map((item) => [
      item.market,
      item.generated,
      item.operated,
      formatPercent(item.win_rate),
      formatMoney(item.profit),
    ]),
  );
  confidenceStats.innerHTML = renderStatsTable(
    ['Confianza', 'Generadas', 'Operadas', 'Win Rate'],
    (stats.by_confidence || []).map((item) => [
      item.confidence,
      item.generated,
      item.operated,
      formatPercent(item.win_rate),
    ]),
  );
  discardStats.innerHTML = renderStatsTable(
    ['Motivo', 'Conteo', 'Porcentaje'],
    (stats.discard_reasons || []).map((item) => [
      item.reason,
      item.count,
      formatPercent(item.percentage),
    ]),
  );
  financialStats.innerHTML = [
    statsCard('Profit total', formatMoney(financial.profit_total)),
    statsCard('Operaciones ganadas', financial.wins ?? 0),
    statsCard('Operaciones perdidas', financial.losses ?? 0),
    statsCard('Win Rate general', formatPercent(financial.win_rate)),
  ].join('');
}

function setActiveTab(tab) {
  const isStats = tab === 'stats';
  operativeTab.classList.toggle('active', !isStats);
  statsTab.classList.toggle('active', isStats);
  operativeView.classList.toggle('active', !isStats);
  statsView.classList.toggle('active', isStats);
  if (isStats) fetchStats();
  else setTimeout(resizeChart, 0);
}

operativeTab.addEventListener('click', () => setActiveTab('operative'));
statsTab.addEventListener('click', () => setActiveTab('stats'));
refreshStatsButton.addEventListener('click', fetchStats);

async function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!marketInput.value.trim()) {
        markets = data.markets || [];
        if (!selectedSymbol && markets.length) selectedSymbol = markets[0].symbol;
        renderMarketList();
      }
      const selectedMarket = markets.find((m) => m.symbol === selectedSymbol);
      if (selectedMarket) await renderSelected(selectedSymbol, selectedMarket);
      renderHistory(data.signals || []);
      if (!websocketPrimed) {
        (data.markets || []).forEach((market) => {
          const key = signalKey(market);
          if (key) playedSignalKeys.add(key);
        });
        websocketPrimed = true;
        return;
      }
      const newAlert = (data.markets || []).find((market) => {
        const key = signalKey(market);
        return key && market.active && market.score >= 4 && !playedSignalKeys.has(key);
      });
      if (newAlert) {
        playedSignalKeys.add(signalKey(newAlert));
        if (!muteAlerts) await playAlertTone();
      }
    } catch (error) {
      console.error('Error al procesar mensaje WebSocket:', error);
    }
  };
  socket.onclose = () => setTimeout(initWebSocket, 3000);
  socket.onerror = () => socket.close();
}

createChart();
fetchMarkets();
fetchHistory();
fetchStats();
initWebSocket();
