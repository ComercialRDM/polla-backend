# Tracking de atribucion de marketing y conversiones (GA4 + Postgres)

Este documento explica el sistema de atribucion implementado para medir de que canal viene cada venta de bono: email, SMS, WhatsApp/ManyChat, cada influencer individual, cada amigo (programa "invita amigos"), pauta paga, y organico/directo.

Convive en paralelo con el sistema existente de afiliados/referidos (`aff_token`/`ref`, tablas `referido_clics`/`comisiones`, firma HMAC en `src/utils/referidoTokens.js`) -- no lo modifica ni lo reemplaza. Las UTMs nuevas se guardan ademas, sin verificacion criptografica, porque no mueven comision/dinero.

## Arquitectura

1. **Frontend** captura UTMs/referrer/landing page de la URL al cargar cualquier pagina (`src/lib/attribution.js`), las guarda en `localStorage` con modelo first-touch (nunca se sobreescribe) + last-touch (se actualiza con cada visita que traiga una UTM nueva).
2. Al comprar, el frontend adjunta esa atribucion al crear la transaccion (las 4 rutas de pago: Wompi widget, PSE, Boton Bancolombia, Transferencia/BreB).
3. **Backend** sanea los campos recibidos y clasifica el canal (`src/utils/atribucion.js`, funcion `clasificarCanal`) dando prioridad a las senales YA verificadas (codigo de afiliado con firma HMAC valida, o token de amigo) sobre las UTMs libres declaradas por el cliente.
4. Todo queda guardado en columnas nuevas de `transacciones` -- la fuente de verdad para reportes en Postgres/Admin.
5. **GA4**: el frontend dispara `view_item` / `begin_checkout` / `add_payment_info` / `purchase` con gtag.js (`src/lib/analytics.js`), incluyendo los mismos datos de atribucion como parametros custom del evento. `purchase` solo se dispara cuando el backend confirma `estado_pago = 'APROBADO'` (nunca antes), con guardia anti-duplicado por `transaction_id`.

## Archivos tocados

**Backend (polla-backend)**
- `src/server.js` -- migracion de columnas nuevas en `transacciones`.
- `src/utils/atribucion.js` (nuevo) -- `extraerAtribucion()`, `clasificarCanal()`, `sanear()`. Fuente de verdad de las reglas de clasificacion.
- `src/routes/transacciones.js` -- las 4 rutas de creacion de pago reciben, sanean y guardan la atribucion.
- `src/routes/polla.js` -- `GET /api/polla/info` ahora devuelve tambien `valor_pagado`, `saldo_bono`, `attribution_group` de la transaccion (los necesita el frontend para disparar `purchase` con el valor correcto).
- `src/routes/admin.js` -- nuevos endpoints `GET /ventas-por-canal`, `GET /ventas-por-campana`, `GET /ranking-amigos`.
- `scripts/ga4-report.js` -- nuevos tipos de reporte `revenue-canal`, `revenue-source-medium`, `revenue-campana`, `revenue-referral-group`.

**Frontend (polla-frontend)**
- `src/lib/attribution.js` (nuevo) -- captura, storage (first/last touch, TTL 30 dias), `getAttributionGroup()`.
- `src/lib/analytics.js` (nuevo) -- helpers de GA4 ecommerce con atribucion automatica y anti-duplicado de `purchase`.
- `src/App.jsx` -- nuevo componente `CapturarAtribucion`, corre en cada navegacion.
- `src/api.js` -- las 4 funciones `crear*` mandan los campos de atribucion al backend; nuevas funciones `adminVentasPorCanal`, `adminVentasPorCampana`, `adminRankingAmigos`.
- `src/pages/Comprar.jsx` -- dispara `view_item`/`begin_checkout`/`add_payment_info`, adjunta atribucion a la compra.
- `src/pages/Gracias.jsx` -- dispara `purchase` solo cuando el backend confirma el pago.

## Columnas agregadas en `transacciones`

```sql
utm_source TEXT
utm_medium TEXT
utm_campaign TEXT
utm_content TEXT
utm_term TEXT
referrer TEXT
landing_page TEXT
first_touch_at TIMESTAMPTZ
attribution_group TEXT  -- email | sms | whatsapp | influencer | friend | paid_ads | organic_social | organic_search | direct | referral
```

## Como crear URLs con UTMs

Formato general: `https://ganaconretoucherie.com/comprar?utm_source=X&utm_medium=Y&utm_campaign=Z&utm_content=W`

| Canal | utm_source | utm_medium | utm_campaign | utm_content |
|---|---|---|---|---|
| Email (Brevo) | `brevo` o `newsletter` | `email` | nombre de la campana, ej. `lanzamiento-julio` | nombre del bloque/boton, ej. `banner-superior` |
| SMS (Twilio) | `twilio` | `sms` | igual que arriba | opcional |
| WhatsApp/ManyChat | `manychat` (o `whatsapp`) | `whatsapp` | igual que arriba | opcional |
| Influencer | -- (usa `?aff=CODIGO`, ver abajo) | `influencer` (si no se usa `aff`) | nombre de la campana | nombre/identificador del influencer |
| Amigo | -- (usa `?ref=` automatico desde "Invita amigos") | `friend` (si no se usa `ref`) | -- | -- |
| Pauta paga (Meta/Google Ads) | `facebook`, `google`, etc. | `paid_social` o `cpc` | nombre de la campana de ads | nombre del anuncio/creativo |

**Importante para influencers y amigos**: el sistema YA tiene su propio mecanismo mas confiable (`?aff=CODIGO` para influencers, `?ref=` que se genera solo al compartir desde "Invita amigos") -- ese mecanismo manda sobre cualquier `utm_medium` libre. Las UTMs en esos links son opcionales/descriptivas, no la fuente de verdad. Ver limitacion conocida sobre `friend_name` abajo.

**Evitar errores de naming**: usa siempre minusculas, sin espacios (usa guiones `-`), y manten una convencion fija por campana (ej. `lanzamiento-julio`, no `Lanzamiento_Julio` en un link y `lanzamientoJulio` en otro) -- valores distintos para la "misma" campana aparecen como filas separadas en los reportes.

## Limitaciones conocidas (documentadas a proposito, no ocultas)

1. **Transferencia bancaria / BreB**: estos metodos no tienen webhook, la aprobacion es manual desde el panel admin (a veces dias despues). El evento `purchase` de GA4 solo se dispara si el cliente vuelve a `/gracias?token=...` despues de la aprobacion -- si no vuelve, esa venta queda en Postgres (fuente de verdad) pero no en GA4. Es una limitacion aceptada para mantener la solucion simple (gtag.js puro, sin Measurement Protocol server-side); si en el futuro se necesita 100% de cobertura, requeriria un envio server-side desde `aprobarTransaccion`.
2. **`friend_name`**: el sistema de "invita amigos" (`ref`) solo guarda un UUID, no hay nombre/identificador legible de que amigo comparte. El ranking en `/admin/ranking-amigos` identifica al amigo por su propia cuenta (nombre real), pero si se quiere reportar por "codigo de amigo" como con influencers, hace falta una decision de producto aparte (crear codigos cortos por amigo).
3. **Anti-duplicado de `purchase` es por navegador**: la guardia usa `localStorage`. Si el cliente borra el storage o abre el link de confirmacion en otro dispositivo, podria duplicarse en GA4 (no en Postgres, que sigue siendo exacto). Es el mismo trade-off de cualquier implementacion GA4 client-side estandar.

## Custom Dimensions que hay que crear manualmente en GA4

Sin esto, `revenue-referral-group` y los parametros `influencer_name`/`friend_name`/`campaign_content` no se pueden consultar via la Data API (aunque ya lleguen como parametros del evento):

1. Entra a GA4 -> Admin -> Custom definitions -> Create custom dimension.
2. Crea estas 4, todas con scope **Event**:
   - Dimension name: `Referral Group` -- Event parameter: `referral_group`
   - Dimension name: `Campaign Content` -- Event parameter: `campaign_content`
   - Dimension name: `Influencer Name` -- Event parameter: `influencer_name`
   - Dimension name: `Friend Name` -- Event parameter: `friend_name`
3. Tardan unas horas en empezar a poblarse despues de creadas (no son retroactivas: solo cuentan eventos que lleguen DESPUES de crear la dimension).

## Como validar en GA4 DebugView

1. Instala la extension "Google Analytics Debugger" en Chrome, o agrega `?gtm_debug=1` a la URL (o usa el modo debug nativo de gtag con `gtag('config', 'G-B33ZXGVN96', { debug_mode: true })` temporalmente).
2. Entra a GA4 -> Admin -> DebugView.
3. Navega el sitio con una URL de prueba, ej.: `http://localhost:5173/comprar?utm_source=test&utm_medium=email&utm_campaign=prueba-debug`
4. Deberias ver en tiempo real: `view_item` al cargar el plan, `begin_checkout` al enviar el formulario, `add_payment_info` justo antes de la llamada al backend, y `purchase` en `/gracias` una vez el backend confirme el pago -- cada uno con los parametros `campaign_source`, `campaign_medium`, `campaign_name`, `referral_group`, etc.

## Como verificar ventas por canal en Postgres y en Admin

**Directo en Postgres:**
```sql
SELECT COALESCE(attribution_group, 'sin_clasificar') AS canal, COUNT(*), SUM(valor_pagado)
FROM transacciones WHERE estado_pago = 'APROBADO' AND es_test = FALSE
GROUP BY attribution_group ORDER BY 3 DESC;
```

**Via API admin** (requiere token de sesion admin):
- `GET /api/admin/ventas-por-canal?fecha_inicio=2026-06-28&fecha_fin=2026-07-19`
- `GET /api/admin/ventas-por-campana`
- `GET /api/admin/ranking-amigos`
- `GET /api/admin/afiliados` (ya existia, ranking de influencers)

**Via el script de GA4:**
```
node scripts/ga4-report.js revenue-canal 30
node scripts/ga4-report.js revenue-source-medium 30
node scripts/ga4-report.js revenue-campana 30
```

## Como probar end-to-end (manual, antes de cada campana nueva)

1. Abre una pestana nueva (o modo incognito) y entra con `?utm_source=test&utm_medium=email&utm_campaign=prueba`.
2. Revisa en la consola del navegador (modo dev) el log `[atribucion] capturada: ...` -- confirma que aparecen las UTMs.
3. Completa una compra de prueba con un valor bajo (ej. $10.000).
4. En la consola, confirma los logs `[analytics] evento enviado: begin_checkout`, `add_payment_info`.
5. Tras pagar y llegar a `/gracias`, confirma el log `[analytics] evento enviado: purchase` con el `transaction_id` = tu token.
6. Refresca `/gracias` con el mismo `?token=` -- confirma que esta vez el log dice `purchase ya enviado antes... se omite duplicado`.
7. En Postgres, confirma la fila en `transacciones` con `utm_source='test'`, `attribution_group='email'`.
8. Marca la transaccion de prueba con `es_test = TRUE` (o borrala) para que no contamine los reportes reales.
