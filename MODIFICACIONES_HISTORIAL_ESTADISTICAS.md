# Modificaciones de historial y estadisticas

## Modulos respetados

- `detect_signals()` conserva la logica de analisis, direccion, score y confianza.
- `compose_telegram_alert()`, `send_telegram_message()` y `send_telegram_alert()` conservan la integracion con Telegram.
- Los listeners de mercado y el grafico del frontend se mantienen sin cambiar su flujo principal.

## Correccion del historial

- La causa del reinicio visible era el uso de limites en memoria y API: el backend cargaba solo 100 registros, enviaba `signal_history[-100:]` por WebSocket y recortaba la lista en memoria a 200.
- El historial ahora se reconstruye desde SQLite sin limite artificial y se emite completo al frontend.
- Las senales existentes se migran con `signal_id`, `confidence`, estado `PENDIENTE` y timestamps sin borrar datos previos.

## Nuevas funciones

- Cada senal queda registrada con campos para decision humana, motivo de descarte, monto, payout, resultado y profit.
- La interfaz muestra acciones compactas `OPERAR` e `IGNORAR` dentro de cada fila del historial.
- La pestana `Estadisticas` calcula metricas desde SQLite: totales, mercados, confianza, motivos de descarte y resultados financieros.
