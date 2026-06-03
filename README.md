<<<<<<< HEAD
# Alertas de Trading Blitz

Aplicación web de señales para opciones binarias en formato Blitz (IQ Option) con monitoreo de múltiples mercados y alertas a Telegram.

## Funcionalidades

- Monitorea Forex, cripto y acciones OTC.
- Agrega, activa/desactiva y elimina mercados desde la interfaz.
- Analiza velas de 1 minuto con señales calibradas para expiraciones ultracortas.
- Envía alertas a Telegram cuando detecta señales de alta probabilidad.
- Guarda mercados y señales en SQLite.
- Gráfico de velas con LightweightCharts, EMA 21, Bandas de Bollinger y marcadores de señal.

## Requisitos

- Python 3.11+
- Cuenta gratuita en Twelve Data
- Bot de Telegram con BotFather

## Instalación

1. Clona o copia este proyecto.
2. Crea y activa un entorno virtual:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

3. Instala dependencias:

```powershell
pip install -r requirements.txt
```

4. Crea un archivo `.env` basado en `.env.example`.

## Configuración de APIs

### Twelve Data

1. Regístrate en https://twelvedata.com.
2. Copia tu API Key gratuita.
3. Pega el valor en `TWELVE_DATA_API_KEY`.

### Telegram

1. Crea un bot con BotFather en Telegram.
2. Conserva el `BOT_TOKEN` que te da BotFather.
3. Para obtener tu `CHAT_ID`, abre tu bot o un chat con él y visita este enlace en el navegador:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

4. Busca `chat.id` en la respuesta JSON.

## Ejecución

```powershell
uvicorn app:app --reload
```

Luego abre `http://127.0.0.1:8000`.

## Uso

- Agrega mercados como `BTC/USD`, `ETH/USD`, `EUR/USD` o `AAPL`.
- Activa/desactiva mercados sin perder su configuración.
- Selecciona un mercado para ver su gráfico y últimas señales.
- Usa el botón de silencio para desactivar sonidos de alerta.

## Fuentes de datos

- Los pares cripto contra dólar, como `BTC/USD` y `ETH/USD`, usan Coinbase Exchange.
- Los pares cripto contra stablecoin, como `BTC/USDT` y `ETH/USDT`, usan Binance Spot.
- Forex y acciones usan Twelve Data y consumen la cuota configurada en `TWELVE_DATA_API_KEY`.
- Cada broker forma sus propias velas. Para comparar señales con una operación en USD, activa el par `*/USD` y evita usar su variante `*/USDT`.

## Cómo hospedar gratis 24/7

### Railway.app

1. Crea cuenta en https://railway.app.
2. Importa el repositorio desde GitHub o sube el código.
3. Crea variables de entorno con los valores de `.env`.
4. Configura el comando de inicio: `uvicorn app:app --host 0.0.0.0 --port $PORT`.
5. Despliega.

### Render.com

1. Crea cuenta en https://render.com.
2. Crea un nuevo "Web Service".
3. Selecciona el repositorio o sube el proyecto.
4. Usa `python -m pip install -r requirements.txt` en Build Command.
5. Usa `uvicorn app:app --host 0.0.0.0 --port $PORT` en Start Command.
6. Agrega las variables de entorno.

## Notas

- El sistema sugiere expiraciones entre 30 segundos y 3 minutos según la señal.
- Solo alerta por Telegram cuando la señal tiene puntaje mayor o igual a `MIN_SCORE_TO_ALERT`.
- Se evita enviar más de una alerta por par cada `ALERT_COOLDOWN_SECONDS` segundos.
=======
# tradingbot
>>>>>>> 508c86c71cb22e0ca6fc8db62191c2d9be4b0bd3
