const marketList = document.getElementById('marketList');
const historyList = document.getElementById('historyList');
const selectedSymbolEl = document.getElementById('selectedSymbol');
const selectedInfoEl = document.getElementById('selectedInfo');
const selectedScoreEl = document.getElementById('selectedScore');
const signalSummary = document.getElementById('signalSummary');
const marketInput = document.getElementById('marketInput');
const addMarketButton = document.getElementById('addMarketButton');
const silenceButton = document.getElementById('silenceButton');
const telegramTestButton = document.getElementById('telegramTestButton');
const telegramStatusEl = document.getElementById('telegramStatus');

let markets = [];
let selectedSymbol = null;
let muteAlerts = false;
let chart;
let candleSeries;
let emaSeries;
let upperSeries;
let lowerSeries;
let markerApi;

function playAlertTone() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = 520;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.stop(context.currentTime + 0.35);

    setTimeout(() => {
      context.close().catch(() => {});
    }, 500);
  } catch (error) {
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
    audio.volume = 0.4;
    audio.play().catch(() => {});
  }
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

async function fetchMarkets() {
  const res = await fetch('/api/markets', { cache: 'no-store' });
  markets = await res.json();
  if (!selectedSymbol && markets.length) selectedSymbol = markets[0].symbol;
  renderMarketList();
  if (selectedSymbol) await renderSelected(selectedSymbol);
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
  await fetchMarkets();
}

async function deleteMarket(symbol) {
  if (!confirm(`Eliminar mercado ${symbol}?`)) return;
  const res = await fetch(`/api/markets/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  if (!res.ok) console.error('Delete failed', await res.text());
  await fetchMarkets();
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
    marketInput.value = '';
    await fetchMarkets();
  }
});

marketInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addMarketButton.click();
});

silenceButton.addEventListener('click', () => {
  muteAlerts = !muteAlerts;
  silenceButton.textContent = muteAlerts ? 'Alertas silenciadas' : 'Silenciar alertas';
  silenceButton.classList.toggle('muted', muteAlerts);
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

function renderHistory(signals) {
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

async function fetchHistory() {
  const res = await fetch('/api/signals', { cache: 'no-store' });
  if (res.ok) renderHistory(await res.json());
}

async function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      markets = data.markets || [];
      if (!selectedSymbol && markets.length) selectedSymbol = markets[0].symbol;
      renderMarketList();
      const selectedMarket = markets.find((m) => m.symbol === selectedSymbol);
      if (selectedMarket) await renderSelected(selectedSymbol, selectedMarket);
      renderHistory(data.signals || []);
      if (!muteAlerts && selectedMarket?.score >= 6) {
        playAlertTone();
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
initWebSocket();
