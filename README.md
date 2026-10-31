# Celeste

Visor climático de Costa Rica: radar de lluvia (COCESNA), satélite GOES, lluvia estimada (IMERG),
mar, suelo, vegetación, partículas e incendios (NASA GIBS), y pronóstico y clima histórico de
cualquier punto (Open-Meteo / ERA5).

## Estructura
- `src/worker.js` — Worker de Cloudflare: puente al radar de COCESNA (`/api/radar/*`) y contraseña opcional.
- `public/` — la página (Leaflet).
- `wrangler.jsonc` — configuración del Worker.

## Contraseña
Si se define el secreto `SITE_PASSWORD` en Cloudflare, el sitio la pide. Sin él, queda abierto
(con `noindex`).

## Pendientes antes de uso comercial
- Convenio con COCESNA para el radar.
- Plan pago de Open-Meteo (el gratuito es solo no comercial).
- Licencias comerciales de mapas de fondo (CARTO / Esri).
