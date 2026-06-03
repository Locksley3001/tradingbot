import asyncio
import json
import math
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import aiohttp
from aiohttp import ClientTimeout
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# Ensure a `.env` exists: copy from `.env.example` if the user placed credentials there
env_path = os.path.join(os.path.dirname(__file__), ".env")
example_path = os.path.join(os.path.dirname(__file__), ".env.example")
if not os.path.exists(env_path) and os.path.exists(example_path):
    try:
        with open(example_path, "r", encoding="utf-8") as src, open(env_path, "w", encoding="utf-8") as dst:
            dst.write(src.read())
    except Exception:
        pass

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
TWELVE_DATA_API_KEY = os.getenv("TWELVE_DATA_API_KEY", "")
MIN_SCORE_TO_ALERT = int(os.getenv("MIN_SCORE_TO_ALERT", "4"))
ALERT_COOLDOWN_SECONDS = int(os.getenv("ALERT_COOLDOWN_SECONDS", "180"))
DB_PATH = os.path.join(os.path.dirname(__file__), "alerts.db")
NO_CANDLE_RETRY_SECONDS = int(os.getenv("NO_CANDLE_RETRY_SECONDS", "300"))
MAX_SIGNAL_AGE_SECONDS = int(os.getenv("MAX_SIGNAL_AGE_SECONDS", "180"))

DEFAULT_MARKETS = [
    "EUR/USD",
    "GBP/USD",
    "USD/JPY",
    "AUD/USD",
    "EUR/GBP",
    "BTC/USD",
    "ETH/USD",
]

CRYPTO_BASES = {"BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "LINK", "AVAX"}
CRYPTO_QUOTES = {"USD", "USDT", "USDC", "BUSD", "BTC", "ETH"}

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.row_factory = sqlite3.Row
lock = asyncio.Lock()

market_states: Dict[str, Dict[str, Any]] = {}
market_tasks: Dict[str, asyncio.Task] = {}
websocket_clients: List[WebSocket] = []
signal_history: List[Dict[str, Any]] = []
alert_timestamps: Dict[str, float] = {}


def default_market_state() -> Dict[str, Any]:
    return {
        "candles": [],
        "last_score": 0,
        "last_direction": "none",
        "last_tags": [],
        "last_expiration": "",
        "data_status": "Esperando datos",
        "last_error": "",
        "last_update": "",
        "last_signal_signature": "",
        "last_alert_signature": "",
        "last_signal_time": 0,
        "received_live_update": False,
        "signal_status": "waiting",
        "analysis": {},
        "last_telegram_status": "",
        "last_telegram_update": "",
        "data_source": "",
    }


def init_db() -> None:
    with conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS markets (symbol TEXT PRIMARY KEY, category TEXT, active INTEGER, created_at TEXT)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, symbol TEXT, direction TEXT, score INTEGER, tags TEXT, expiration TEXT, entry_price REAL, details TEXT, signal_time INTEGER)"
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(signals)").fetchall()}
        if "signal_time" not in columns:
            conn.execute("ALTER TABLE signals ADD COLUMN signal_time INTEGER")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS signals_unique_candle ON signals(symbol, signal_time, direction)"
        )

        existing = conn.execute("SELECT COUNT(*) as count FROM markets").fetchone()["count"]
        if existing == 0:
            for symbol in DEFAULT_MARKETS:
                category = detect_category(symbol)
                conn.execute(
                    "INSERT OR IGNORE INTO markets (symbol, category, active, created_at) VALUES (?, ?, ?, ?)"
                    , (symbol, category, 1, datetime.utcnow().isoformat())
                )


def load_signal_history(limit: int = 100) -> None:
    signal_history.clear()
    with conn:
        rows = conn.execute(
            "SELECT created_at, symbol, direction, score, tags, expiration FROM signals ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    for row in reversed(rows):
        try:
            tags = json.loads(row["tags"] or "[]")
        except Exception:
            tags = []
        signal_history.append(
            {
                "time": datetime.fromisoformat(row["created_at"]).strftime("%H:%M:%S"),
                "symbol": row["symbol"],
                "direction": row["direction"].upper(),
                "score": row["score"],
                "tags": tags,
                "expiration": row["expiration"],
            }
        )


def normalize_symbol(raw_symbol: str) -> str:
    symbol = raw_symbol.strip().upper().replace(" ", "").replace("\\", "/").replace("_", "/")
    symbol = symbol.replace("//", "/")
    if "/" not in symbol:
        if symbol.endswith("USDT"):
            return f"{symbol[:-4]}/USDT"
        if symbol.endswith("BTC"):
            return f"{symbol[:-3]}/BTC"
        if symbol.endswith("ETH"):
            return f"{symbol[:-3]}/ETH"
        if len(symbol) == 6:
            return f"{symbol[:3]}/{symbol[3:]}"
    return symbol


def detect_category(symbol: str) -> str:
    symbol = symbol.upper().replace(" ", "")
    if "/" in symbol:
        base, quote = symbol.split("/", 1)
        if base in CRYPTO_BASES and quote in CRYPTO_QUOTES:
            return "crypto"
        if len(base) == 3 and len(quote) == 3:
            return "forex"
    return "otc"


def crypto_provider(symbol: str) -> str:
    _, quote = symbol.upper().split("/", 1)
    return "coinbase" if quote == "USD" else "binance"


def market_data_source(symbol: str, category: str) -> str:
    if category == "crypto":
        return "Coinbase Exchange USD" if crypto_provider(symbol) == "coinbase" else "Binance Spot"
    return "Twelve Data"


def parse_float(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def candle_from_binance(kline: List[Any]) -> Dict[str, Any]:
    return {
        "time": int(kline[0]) // 1000,
        "open": parse_float(kline[1]),
        "high": parse_float(kline[2]),
        "low": parse_float(kline[3]),
        "close": parse_float(kline[4]),
        "volume": parse_float(kline[5]),
    }


def candle_from_coinbase(item: List[Any]) -> Dict[str, Any]:
    return {
        "time": int(item[0]),
        "low": parse_float(item[1]),
        "high": parse_float(item[2]),
        "open": parse_float(item[3]),
        "close": parse_float(item[4]),
        "volume": parse_float(item[5]),
    }


def candle_from_twelvedata(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "time": int(datetime.fromisoformat(item["datetime"]).timestamp()),
        "open": parse_float(item["open"]),
        "high": parse_float(item["high"]),
        "low": parse_float(item["low"]),
        "close": parse_float(item["close"]),
        "volume": parse_float(item.get("volume", 0)),
    }


async def fetch_initial_candles(symbol: str, category: str) -> List[Dict[str, Any]]:
    if category == "crypto":
        provider = crypto_provider(symbol)
        if provider == "coinbase":
            product_id = symbol.replace("/", "-").upper()
            url = f"https://api.exchange.coinbase.com/products/{product_id}/candles?granularity=60"
        else:
            rest_symbol = symbol.replace("/", "").upper()
            url = f"https://api.binance.com/api/v3/klines?symbol={rest_symbol}&interval=1m&limit=60"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=ClientTimeout(total=20)) as response:
                data = await response.json()
                if response.status != 200 or not isinstance(data, list):
                    message = data.get("message") or data.get("msg") if isinstance(data, dict) else f"HTTP {response.status}"
                    source = "Coinbase" if provider == "coinbase" else "Binance"
                    raise RuntimeError(f"{source} no devolvió velas para {symbol}: {message}")
                candles = [
                    candle_from_coinbase(item) if provider == "coinbase" else candle_from_binance(item)
                    for item in data
                    if isinstance(item, list)
                ]
                return sorted(candles, key=lambda candle: candle["time"])[-60:]
    else:
        if not TWELVE_DATA_API_KEY:
            raise RuntimeError("Falta TWELVE_DATA_API_KEY")
        url = "https://api.twelvedata.com/time_series"
        params = {
            "symbol": symbol,
            "interval": "1min",
            "outputsize": 60,
            "apikey": TWELVE_DATA_API_KEY,
            "format": "JSON",
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, timeout=ClientTimeout(total=20)) as response:
                data = await response.json()
                if response.status != 200 or data.get("status") == "error":
                    message = data.get("message") or f"HTTP {response.status}"
                    raise RuntimeError(f"Twelve Data: {message}")
                values = data.get("values") or []
                candles = [candle_from_twelvedata(item) for item in reversed(values)]
                if not candles:
                    raise RuntimeError(f"Twelve Data no devolvió velas para {symbol}")
                return candles


def add_candle(symbol: str, candle: Dict[str, Any]) -> None:
    state = market_states.get(symbol)
    if not state:
        return
    candles = state["candles"]
    if not candles or candle["time"] > candles[-1]["time"]:
        candles.append(candle)
    elif candle["time"] == candles[-1]["time"]:
        candles[-1] = candle
    if len(candles) > 100:
        state["candles"] = candles[-100:]
    state["data_status"] = "Datos en vivo"
    state["last_error"] = ""
    state["last_update"] = datetime.utcnow().isoformat()
    state["received_live_update"] = True


def add_price_tick(symbol: str, price: float, volume: float = 0.0, timestamp: Optional[int] = None) -> None:
    if price <= 0:
        return
    state = market_states.get(symbol)
    if not state:
        return
    tick_time = timestamp or int(datetime.utcnow().timestamp())
    candle_time = tick_time - (tick_time % 60)
    candles = state["candles"]
    if candles and candles[-1]["time"] == candle_time:
        current = candles[-1]
        candle = {
            "time": candle_time,
            "open": current["open"],
            "high": max(current["high"], price),
            "low": min(current["low"], price),
            "close": price,
            "volume": current.get("volume", 0) + volume,
        }
    else:
        candle = {
            "time": candle_time,
            "open": price,
            "high": price,
            "low": price,
            "close": price,
            "volume": volume,
        }
    add_candle(symbol, candle)


def compute_ema(values: List[float], period: int) -> List[float]:
    if not values or len(values) < period:
        return []
    ema = []
    k = 2 / (period + 1)
    ema.append(sum(values[:period]) / period)
    for price in values[period:]:
        ema.append(price * k + ema[-1] * (1 - k))
    return ema


def compute_rsi(values: List[float], period: int = 14) -> List[float]:
    if len(values) < period + 1:
        return []
    gains = []
    losses = []
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
    average_gain = sum(gains) / period
    average_loss = sum(losses) / period
    rsi = []
    if average_loss == 0:
        rsi.append(100.0)
    else:
        rs = average_gain / average_loss
        rsi.append(100 - (100 / (1 + rs)))
    for i in range(period + 1, len(values)):
        change = values[i] - values[i - 1]
        gain = max(change, 0)
        loss = max(-change, 0)
        average_gain = (average_gain * (period - 1) + gain) / period
        average_loss = (average_loss * (period - 1) + loss) / period
        if average_loss == 0:
            rsi.append(100.0)
        else:
            rs = average_gain / average_loss
            rsi.append(100 - (100 / (1 + rs)))
    return rsi


def bollinger_bands(values: List[float], period: int = 20, multiplier: float = 2.0) -> List[Dict[str, float]]:
    bands = []
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        sma = sum(window) / period
        variance = sum((price - sma) ** 2 for price in window) / period
        sd = math.sqrt(variance)
        bands.append({"upper": sma + multiplier * sd, "middle": sma, "lower": sma - multiplier * sd})
    return bands


def candle_direction(candle: Dict[str, Any]) -> str:
    return "bull" if candle["close"] >= candle["open"] else "bear"


def is_strong_body(candle: Dict[str, Any], threshold: float) -> bool:
    body = abs(candle["close"] - candle["open"])
    total_range = candle["high"] - candle["low"]
    if total_range <= 0:
        return False
    return body >= total_range * threshold


def body_ratio(candle: Dict[str, Any]) -> float:
    total_range = candle["high"] - candle["low"]
    if total_range <= 0:
        return 0.0
    return abs(candle["close"] - candle["open"]) / total_range


def upper_shadow(candle: Dict[str, Any]) -> float:
    return candle["high"] - max(candle["open"], candle["close"])


def lower_shadow(candle: Dict[str, Any]) -> float:
    return min(candle["open"], candle["close"]) - candle["low"]


def average(values: List[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def is_indecisive(candle: Dict[str, Any]) -> bool:
    body = abs(candle["close"] - candle["open"])
    shadows = upper_shadow(candle) + lower_shadow(candle)
    return body_ratio(candle) < 0.32 or (body > 0 and shadows > body * 1.6)


def dominant_side(candles: List[Dict[str, Any]]) -> Optional[str]:
    if len(candles) < 3:
        return None
    solid_bulls = sum(1 for candle in candles if candle_direction(candle) == "bull" and body_ratio(candle) >= 0.42)
    solid_bears = sum(1 for candle in candles if candle_direction(candle) == "bear" and body_ratio(candle) >= 0.42)
    move = candles[-1]["close"] - candles[0]["open"]
    typical_body = average([abs(candle["close"] - candle["open"]) for candle in candles])
    if solid_bulls >= solid_bears + 1 and move > typical_body * 0.65:
        return "bull"
    if solid_bears >= solid_bulls + 1 and move < -typical_body * 0.65:
        return "bear"
    return None


def structure_steps(candles: List[Dict[str, Any]], side: str) -> int:
    steps = 0
    for previous, current in zip(candles, candles[1:]):
        if side == "bull" and current["close"] > previous["close"] and current["high"] >= previous["high"]:
            steps += 1
        elif side == "bear" and current["close"] < previous["close"] and current["low"] <= previous["low"]:
            steps += 1
    return steps


def detect_signals(symbol: str) -> Dict[str, Any]:
    state = market_states.get(symbol)
    if not state:
        return {}
    # The newest candle is still forming. Decisions are based on closed candles only.
    closed = state["candles"][:-1][-40:]
    if len(closed) < 10:
        return {
            "score": 0,
            "direction": "none",
            "tags": ["Esperando velas cerradas"],
            "details": ["Aún no hay suficientes velas cerradas para confirmar una entrada."],
            "expiration": "Esperar",
            "entry_price": state["candles"][-1]["close"] if state["candles"] else 0.0,
            "signal_time": 0,
            "signal_status": "waiting",
            "analysis": {},
        }

    latest = closed[-1]
    recent = closed[-6:]
    previous_context = closed[-9:-2]
    dominant = dominant_side(recent)
    previous_dominant = dominant_side(previous_context)
    indecision_count = sum(1 for candle in recent if is_indecisive(candle))
    dominant_solid = sum(
        1
        for candle in recent
        if dominant and candle_direction(candle) == dominant and body_ratio(candle) >= 0.48
    )
    steps = structure_steps(recent, dominant) if dominant else 0

    bodies = [abs(candle["close"] - candle["open"]) for candle in recent[-3:]]
    shrinking_bodies = len(bodies) == 3 and bodies[0] > bodies[1] > bodies[2] and bodies[2] <= bodies[0] * 0.78
    shadow_fights = sum(
        1
        for candle in recent[-4:]
        if abs(candle["close"] - candle["open"]) > 0
        and upper_shadow(candle) + lower_shadow(candle) > abs(candle["close"] - candle["open"]) * 1.35
    )
    failed_progress = False
    if previous_dominant == "bull":
        failed_progress = latest["high"] <= max(candle["high"] for candle in closed[-4:-1])
    elif previous_dominant == "bear":
        failed_progress = latest["low"] >= min(candle["low"] for candle in closed[-4:-1])

    fatigue_points = int(shrinking_bodies) + int(shadow_fights >= 2) + int(failed_progress)
    fatigue = "Alto" if fatigue_points >= 2 else "Medio" if fatigue_points == 1 else "Bajo"

    last_two = closed[-2:]
    two_solid_bulls = all(candle_direction(candle) == "bull" and body_ratio(candle) >= 0.45 for candle in last_two)
    two_solid_bears = all(candle_direction(candle) == "bear" and body_ratio(candle) >= 0.45 for candle in last_two)
    bullish_break = two_solid_bulls and latest["close"] > closed[-3]["high"] and latest["close"] > last_two[0]["close"]
    bearish_break = two_solid_bears and latest["close"] < closed[-3]["low"] and latest["close"] < last_two[0]["close"]
    reversal_side = None
    if previous_dominant == "bear" and bullish_break:
        reversal_side = "bull"
    elif previous_dominant == "bull" and bearish_break:
        reversal_side = "bear"

    last_two_follow_dominant = (
        dominant is not None
        and all(candle_direction(candle) == dominant and body_ratio(candle) >= 0.42 for candle in last_two)
    )
    clear_continuity = dominant is not None and last_two_follow_dominant and steps >= 2 and indecision_count <= 2
    resumed_after_weak_pullback = False
    if dominant and len(closed) >= 3:
        before, pullback, confirmation = closed[-3:]
        resumed_after_weak_pullback = (
            candle_direction(before) == dominant
            and candle_direction(pullback) != dominant
            and body_ratio(pullback) <= 0.42
            and candle_direction(confirmation) == dominant
            and body_ratio(confirmation) >= 0.5
            and (
                (dominant == "bull" and confirmation["close"] > pullback["high"])
                or (dominant == "bear" and confirmation["close"] < pullback["low"])
            )
        )

    strength = "Débil"
    if dominant_solid >= 3 and steps >= 3:
        strength = "Fuerte"
    elif dominant_solid >= 2 and steps >= 2:
        strength = "Media"

    continuity = "Fuerte" if clear_continuity and strength == "Fuerte" else "Media" if clear_continuity or resumed_after_weak_pullback else "Débil"
    possible_reversal = previous_dominant is not None and fatigue_points >= 1 and (
        candle_direction(latest) != previous_dominant or shadow_fights >= 2
    )

    direction = "none"
    signal_status = "waiting"
    score = 0
    tags: List[str] = []
    explanation = "No hay confirmación suficiente. El mercado no muestra continuidad limpia ni una reversa confirmada."

    if reversal_side and indecision_count <= 2:
        direction = "call" if reversal_side == "bull" else "put"
        signal_status = "confirmed"
        score = 5 + int(fatigue == "Alto") + int(indecision_count == 0)
        tags = ["Reversa confirmada", "Ruptura de estructura", "Fuerza opuesta en 2 velas"]
        explanation = "La presión previa perdió continuidad y dos velas sólidas en sentido contrario rompieron la estructura reciente."
    elif (clear_continuity or resumed_after_weak_pullback) and dominant:
        direction = "call" if dominant == "bull" else "put"
        signal_status = "confirmed"
        score = 3
        score += 2 if strength == "Fuerte" else 1
        score += 1 if steps >= 3 else 0
        score += 1 if resumed_after_weak_pullback else 0
        score += 1 if indecision_count == 0 else 0
        tags = ["Continuidad confirmada", "Cuerpos sólidos"]
        if steps >= 3:
            tags.append("Estructura sostenida")
        if resumed_after_weak_pullback:
            tags.append("Retroceso débil superado")
        explanation = "El movimiento mantiene dirección, cuerpos consistentes y confirmación reciente sin indecisión importante."
    elif possible_reversal:
        signal_status = "possible_reversal"
        score = min(3, 1 + fatigue_points)
        tags = ["Posible reversa en observación"]
        if shrinking_bodies:
            tags.append("Cuerpos perdiendo fuerza")
        if shadow_fights >= 2:
            tags.append("Sombras repetidas")
        explanation = "Hay pérdida de fuerza o rechazo, pero todavía falta ruptura de estructura y fuerza opuesta confirmada."

    confidence = "Fuerte" if score >= 7 else "Media" if score >= MIN_SCORE_TO_ALERT else "Débil"
    continuity_probability = min(90, 35 + steps * 12 + dominant_solid * 6 - indecision_count * 8) if dominant else 25
    reversal_probability = min(85, 20 + fatigue_points * 18 + (25 if reversal_side else 0))
    analysis = {
        "dominant_direction": "Alcista" if dominant == "bull" else "Bajista" if dominant == "bear" else "No definida",
        "strength": strength,
        "continuity": continuity,
        "fatigue": fatigue,
        "continuity_probability": max(10, continuity_probability),
        "reversal_probability": max(10, reversal_probability),
        "confidence": confidence,
        "explanation": explanation,
    }

    return {
        "score": min(10, score),
        "direction": direction,
        "tags": tags,
        "details": [explanation],
        "expiration": estimate_expiration(tags, direction),
        "entry_price": latest["close"],
        "signal_time": latest["time"],
        "signal_status": signal_status,
        "analysis": analysis,
    }


def estimate_expiration(tags: List[str], direction: str) -> str:
    if "Reversa confirmada" in tags:
        return "1m - 2m"
    if "Retroceso débil superado" in tags:
        return "1m - 3m"
    if "Continuidad confirmada" in tags:
        return "1m - 2m"
    return "Esperar"


def compose_telegram_alert(
    symbol: str,
    direction: str,
    score: int,
    tags: List[str],
    expiration: str,
    price: float,
    analysis: Optional[Dict[str, Any]] = None,
    manual: bool = False,
) -> str:
    heading = "PRUEBA MANUAL" if manual else ("SEÑAL FUERTE" if score >= 6 else "SEÑAL")
    side = "PUT" if direction == "put" else "CALL"
    icon = "🔴" if direction == "put" else "🟢"
    tag_text = " + ".join(tags) if tags else "Prueba de envío"
    analysis = analysis or {}
    return (
        f"{heading}\n"
        f"{icon} {side} - {symbol}\n"
        f"Dirección: {side}\n"
        f"Puntuación: {score}/10\n"
        f"Señales: {tag_text}\n"
        f"Fuerza: {analysis.get('strength', 'Sin evaluar')}\n"
        f"Continuidad: {analysis.get('continuity', 'Sin evaluar')}\n"
        f"Cansancio: {analysis.get('fatigue', 'Sin evaluar')}\n"
        f"Confianza: {analysis.get('confidence', 'Sin evaluar')}\n"
        f"Expiración sugerida: {expiration}\n"
        f"Precio de entrada: {price:.5f}\n"
        f"Hora UTC: {datetime.utcnow().strftime('%H:%M:%S')}"
    )


async def send_telegram_message(text: str) -> Dict[str, Any]:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return {"ok": False, "error": "Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID"}
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": text}
    async with aiohttp.ClientSession() as session:
        try:
            async with session.post(url, json=payload, timeout=ClientTimeout(total=10)) as response:
                body = await response.json(content_type=None)
                if response.status == 200 and body.get("ok"):
                    return {"ok": True}
                description = body.get("description") if isinstance(body, dict) else str(body)
                return {"ok": False, "error": description or f"HTTP {response.status}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


async def send_telegram_alert(
    symbol: str,
    direction: str,
    score: int,
    tags: List[str],
    expiration: str,
    price: float,
    analysis: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    now = time.time()
    cooldown_key = f"{symbol}:{direction}"
    cooldown = alert_timestamps.get(cooldown_key, 0)
    if now - cooldown < ALERT_COOLDOWN_SECONDS:
        return {"ok": False, "skipped": "cooldown"}
    if score < MIN_SCORE_TO_ALERT:
        return {"ok": False, "skipped": "score"}
    result = await send_telegram_message(compose_telegram_alert(symbol, direction, score, tags, expiration, price, analysis))
    if result.get("ok"):
        alert_timestamps[cooldown_key] = now
    return result


async def broadcast_update() -> None:
    data = {
        "markets": await get_markets_payload(),
        "signals": signal_history[-100:],
    }
    for client in websocket_clients.copy():
        try:
            await client.send_json(data)
        except Exception:
            if client in websocket_clients:
                websocket_clients.remove(client)


async def get_markets_payload() -> List[Dict[str, Any]]:
    with conn:
        rows = conn.execute("SELECT symbol, category, active FROM markets ORDER BY active DESC, symbol").fetchall()
    payload = []
    for row in rows:
        symbol = row["symbol"]
        state = market_states.get(symbol, {})
        payload.append(
            {
                "symbol": symbol,
                "category": row["category"],
                "active": bool(row["active"]),
                "score": state.get("last_score", 0),
                "direction": state.get("last_direction", "none"),
                "tags": state.get("last_tags", []),
                "expiration": state.get("last_expiration", ""),
                "candles": state.get("candles", [])[-60:],
                "data_status": state.get("data_status", "Sin datos"),
                "last_error": state.get("last_error", ""),
                "last_update": state.get("last_update", ""),
                "signal_status": state.get("signal_status", "waiting"),
                "analysis": state.get("analysis", {}),
                "signal_time": state.get("last_signal_time", 0),
                "last_telegram_status": state.get("last_telegram_status", ""),
                "last_telegram_update": state.get("last_telegram_update", ""),
                "data_source": state.get("data_source") or market_data_source(symbol, row["category"]),
            }
        )
    return payload


def signal_already_recorded(symbol: str, signal_time: int, direction: str) -> bool:
    with conn:
        row = conn.execute(
            "SELECT 1 FROM signals WHERE symbol = ? AND signal_time = ? AND direction = ? LIMIT 1",
            (symbol, signal_time, direction),
        ).fetchone()
    return row is not None


async def update_market_state(symbol: str, force: bool = False) -> None:
    state = market_states.get(symbol)
    if not state or len(state["candles"]) < 10:
        return
    result = detect_signals(symbol)
    state.update(
        last_score=result["score"],
        last_direction=result["direction"],
        last_tags=result["tags"],
        last_expiration=result["expiration"],
        signal_status=result["signal_status"],
        analysis=result["analysis"],
        last_signal_time=result["signal_time"],
    )
    signal_time = result["signal_time"]
    signature = json.dumps(
        {
            "time": signal_time,
            "direction": result["direction"],
            "score": result["score"],
            "tags": result["tags"],
        },
        sort_keys=True,
    )
    already_recorded = (
        result["direction"] != "none"
        and signal_already_recorded(symbol, signal_time, result["direction"])
    )

    if (
        result["direction"] != "none"
        and result["signal_status"] == "confirmed"
        and result["score"] >= MIN_SCORE_TO_ALERT
        and state.get("received_live_update")
        and signal_time >= int(time.time()) - MAX_SIGNAL_AGE_SECONDS
        and not already_recorded
        and signature != state.get("last_alert_signature")
    ):
        telegram_result = await send_telegram_alert(
            symbol,
            result["direction"],
            result["score"],
            result["tags"],
            result["expiration"],
            result["entry_price"],
            result["analysis"],
        )
        if telegram_result.get("ok"):
            state["last_alert_signature"] = signature
            state["last_telegram_status"] = "Alerta enviada a Telegram"
        elif telegram_result.get("skipped") == "cooldown":
            state["last_telegram_status"] = "Alerta omitida por cooldown"
        else:
            state["last_telegram_status"] = f"Telegram: {telegram_result.get('error', 'no se pudo enviar')}"
        state["last_telegram_update"] = datetime.utcnow().isoformat()

    if (
        result["direction"] != "none"
        and result["signal_status"] == "confirmed"
        and result["score"] >= MIN_SCORE_TO_ALERT
        and signature != state.get("last_signal_signature")
    ):
        details = ", ".join(result["details"]) if result["details"] else "Señal"
        with conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO signals (created_at, symbol, direction, score, tags, expiration, entry_price, details, signal_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.utcnow().isoformat(),
                    symbol,
                    result["direction"],
                    result["score"],
                    json.dumps(result["tags"]),
                    result["expiration"],
                    result["entry_price"],
                    details,
                    signal_time,
                ),
            )
        if cursor.rowcount:
            signal_history.append(
                {
                    "time": datetime.utcnow().strftime("%H:%M:%S"),
                    "symbol": symbol,
                    "direction": result["direction"].upper(),
                    "score": result["score"],
                    "tags": result["tags"],
                    "expiration": result["expiration"],
                }
            )
            if len(signal_history) > 200:
                del signal_history[:-200]
        state["last_signal_signature"] = signature

    await broadcast_update()


async def ensure_market_task(symbol: str) -> None:
    if symbol in market_tasks and not market_tasks[symbol].done():
        return
    task = asyncio.create_task(market_worker(symbol))
    market_tasks[symbol] = task


async def cancel_market_task(symbol: str) -> None:
    task = market_tasks.get(symbol)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def market_worker(symbol: str) -> None:
    state = market_states.setdefault(symbol, default_market_state())
    category = detect_category(symbol)
    state["data_source"] = market_data_source(symbol, category)
    while True:
        try:
            if not state.get("candles"):
                state["data_status"] = "Cargando velas iniciales"
                await broadcast_update()
                try:
                    state["candles"] = await fetch_initial_candles(symbol, category)
                    state["data_status"] = "Velas iniciales cargadas"
                    state["last_error"] = ""
                    state["last_update"] = datetime.utcnow().isoformat()
                except Exception as exc:
                    state["data_status"] = "Sin velas"
                    state["last_error"] = str(exc)
                    await broadcast_update()
                    await asyncio.sleep(NO_CANDLE_RETRY_SECONDS)
                    continue
                await update_market_state(symbol)
            if category == "crypto":
                if crypto_provider(symbol) == "coinbase":
                    await coinbase_listener(symbol)
                else:
                    await binance_listener(symbol)
            else:
                await twelvedata_listener(symbol)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            state["data_status"] = "Reconectando"
            state["last_error"] = str(exc)
            await broadcast_update()
            await asyncio.sleep(10)


async def binance_listener(symbol: str) -> None:
    stream_symbol = symbol.replace("/", "").lower()
    uri = f"wss://stream.binance.com:9443/ws/{stream_symbol}@kline_1m"
    async with websockets.connect(uri, ping_interval=20, ping_timeout=10) as ws:
        async for message in ws:
            data = json.loads(message)
            if data.get("k"):
                candle = data["k"]
                parsed = {
                    "time": int(candle["t"] // 1000),
                    "open": parse_float(candle["o"]),
                    "high": parse_float(candle["h"]),
                    "low": parse_float(candle["l"]),
                    "close": parse_float(candle["c"]),
                    "volume": parse_float(candle["v"]),
                }
                add_candle(symbol, parsed)
                await update_market_state(symbol)


async def coinbase_listener(symbol: str) -> None:
    product_id = symbol.replace("/", "-").upper()
    uri = "wss://ws-feed.exchange.coinbase.com"
    async with websockets.connect(uri, ping_interval=20, ping_timeout=10) as ws:
        subscribe = {
            "type": "subscribe",
            "product_ids": [product_id],
            "channels": ["ticker", "heartbeat"],
        }
        await ws.send(json.dumps(subscribe))
        async for message in ws:
            payload = json.loads(message)
            if payload.get("type") == "ticker" and payload.get("product_id") == product_id:
                price = parse_float(payload.get("price", 0))
                add_price_tick(symbol, price)
                await update_market_state(symbol)


async def twelvedata_listener(symbol: str) -> None:
    if not TWELVE_DATA_API_KEY:
        await asyncio.sleep(10)
        return
    endpoint = "wss://ws.twelvedata.com/v1/quotes/price"
    async with websockets.connect(f"{endpoint}?apikey={TWELVE_DATA_API_KEY}", ping_interval=20, ping_timeout=10) as ws:
        subscribe = {"action": "subscribe", "symbols": [symbol]}
        await ws.send(json.dumps(subscribe))
        while True:
            message = await ws.recv()
            payload = json.loads(message)
            if isinstance(payload, dict) and payload.get("symbol") == symbol:
                price = parse_float(payload.get("price", 0))
                add_price_tick(symbol, price, parse_float(payload.get("volume", 0)))
                await update_market_state(symbol)


@app.on_event("startup")
async def startup_event() -> None:
    init_db()
    load_signal_history()
    with conn:
        rows = conn.execute("SELECT symbol, active FROM markets").fetchall()
    for row in rows:
        symbol = row["symbol"]
        if row["active"]:
            await ensure_market_task(symbol)
    async def periodic_broadcast() -> None:
        while True:
            await broadcast_update()
            await asyncio.sleep(5)
    asyncio.create_task(periodic_broadcast())


@app.get("/")
async def root() -> FileResponse:
    return FileResponse("static/index.html")


@app.get("/api/markets")
async def list_markets() -> JSONResponse:
    payload = await get_markets_payload()
    return JSONResponse(payload)


@app.post("/api/markets")
async def add_market(payload: Dict[str, Any]) -> JSONResponse:
    symbol = payload.get("symbol")
    if not symbol:
        raise HTTPException(status_code=400, detail="El símbolo es requerido")
    symbol = normalize_symbol(symbol)
    category = detect_category(symbol)
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO markets (symbol, category, active, created_at) VALUES (?, ?, ?, ?)"
            , (symbol, category, 1, datetime.utcnow().isoformat())
        )
    await ensure_market_task(symbol)
    await broadcast_update()
    return JSONResponse({"symbol": symbol, "category": category})


@app.patch("/api/markets/{symbol:path}/toggle")
async def toggle_market(symbol: str) -> JSONResponse:
    symbol = normalize_symbol(symbol)
    with conn:
        row = conn.execute("SELECT active FROM markets WHERE symbol = ?", (symbol,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Mercado no encontrado")
        active = 0 if row["active"] else 1
        conn.execute("UPDATE markets SET active = ? WHERE symbol = ?", (active, symbol))
    if active:
        await ensure_market_task(symbol)
    else:
        await cancel_market_task(symbol)
    await broadcast_update()
    return JSONResponse({"symbol": symbol, "active": bool(active)})


@app.delete("/api/markets/{symbol:path}")
async def delete_market(symbol: str) -> JSONResponse:
    symbol = normalize_symbol(symbol)
    with conn:
        conn.execute("DELETE FROM markets WHERE symbol = ?", (symbol,))
    await cancel_market_task(symbol)
    market_states.pop(symbol, None)
    await broadcast_update()
    return JSONResponse({"symbol": symbol, "deleted": True})


@app.get("/api/signals")
async def get_signals() -> JSONResponse:
    return JSONResponse(signal_history[-100:])


@app.post("/api/telegram/test")
async def test_telegram(payload: Dict[str, Any]) -> JSONResponse:
    symbol = normalize_symbol(str(payload.get("symbol") or "TEST"))
    state = market_states.get(symbol, {})
    candles = state.get("candles") or []
    price = candles[-1]["close"] if candles else 0.0
    direction = state.get("last_direction")
    if direction not in ("call", "put"):
        direction = "call"
    score = int(state.get("last_score") or 0)
    tags = state.get("last_tags") or ["Prueba manual"]
    expiration = state.get("last_expiration") or "Prueba"
    text = compose_telegram_alert(symbol, direction, score, tags, expiration, price, state.get("analysis"), manual=True)
    result = await send_telegram_message(text)
    status_code = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status_code)


@app.get("/api/candles/{symbol:path}")
async def get_candles(symbol: str) -> JSONResponse:
    symbol = normalize_symbol(symbol)
    state = market_states.get(symbol)
    if not state:
        raise HTTPException(status_code=404, detail="Mercado no encontrado")
    return JSONResponse(state["candles"][-60:])


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    websocket_clients.append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in websocket_clients:
            websocket_clients.remove(websocket)


@app.get("/api/status")
async def status() -> JSONResponse:
    with conn:
        active_markets = conn.execute("SELECT COUNT(*) AS count FROM markets WHERE active = 1").fetchone()["count"]
    return JSONResponse(
        {
            "active_markets": active_markets,
            "signals_stored": len(signal_history),
            "telegram_configured": bool(TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID),
            "twelvedata_configured": bool(TWELVE_DATA_API_KEY),
            "min_score_to_alert": MIN_SCORE_TO_ALERT,
            "max_signal_age_seconds": MAX_SIGNAL_AGE_SECONDS,
        }
    )
