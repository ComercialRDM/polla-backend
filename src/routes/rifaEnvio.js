const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const rifaAuth = require('../middleware/rifaAuth');
const {
    manychatRequest, cargarCamposCache, obtenerSubscriberId, SUBSCRIBER_ID_COPIA_CONTROL, NUMERO_COPIA_CONTROL,
} = require('../services/manychatService');

// Envío de las boletas de la rifa por WhatsApp (ManyChat):
//  1. sendFlow con la PLANTILLA aprobada por Meta (funciona fuera de la ventana
//     de 24 h): saludo + números de boleta + botón "Ver mis boletas".
//  2. Al tocar el botón, el flow de ManyChat llama a POST /api/rifa/webhook/ver:
//     se le envían las imágenes y se registra la ENTREGA (fecha y hora).
//  3. El flow pregunta si los datos están bien y llama a /api/rifa/webhook/confirmar:
//     se registra la CONFIRMACIÓN (o el reporte de error) con fecha y hora.
// Solo se envía a clientes con TODAS sus boletas de WhatsApp aprobadas.

const CAMPOS_RIFA = [
    { name: 'rifa_nombre', description: 'Rifa iPhone: primer nombre del cliente' },
    { name: 'rifa_boletas', description: 'Rifa iPhone: números de boleta (ej. #045 y #046)' },
    { name: 'rifa_cantidad', description: 'Rifa iPhone: cantidad de boletas' },
    { name: 'rifa_facturas', description: 'Rifa iPhone: facturas que generaron las boletas' },
];

pool.query(`
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS token_publico CHAR(48);
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS enviado_en TIMESTAMPTZ;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMPTZ;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS confirmado_en TIMESTAMPTZ;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS envio_error TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS rifa_boletas_token_publico ON rifa_boletas (token_publico);
    CREATE TABLE IF NOT EXISTS rifa_envios (
        id SERIAL PRIMARY KEY,
        cedula VARCHAR(30) NOT NULL,
        celular VARCHAR(20) NOT NULL,
        subscriber_id VARCHAR(40),
        numeros INTEGER[] NOT NULL,
        es_prueba BOOLEAN NOT NULL DEFAULT FALSE,
        estado VARCHAR(30) NOT NULL,
        detalle TEXT,
        enviado_en TIMESTAMPTZ,
        entregado_en TIMESTAMPTZ,
        respuesta VARCHAR(20),
        respondido_en TIMESTAMPTZ,
        actor VARCHAR(80),
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS rifa_envios_subscriber ON rifa_envios (subscriber_id, creado_en DESC);
    CREATE TABLE IF NOT EXISTS rifa_contactos_manychat (
        celular VARCHAR(12) PRIMARY KEY,
        subscriber_id VARCHAR(40) NOT NULL,
        actor VARCHAR(80),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rifa_config (
        clave VARCHAR(40) PRIMARY KEY,
        valor TEXT NOT NULL,
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`).catch((err) => console.error('[rifa-envio] Error migrando:', err.message));

async function config(clave) {
    const { rows } = await pool.query('SELECT valor FROM rifa_config WHERE clave = $1', [clave]);
    return rows[0]?.valor || null;
}

async function secreto(clave) {
    let s = await config(clave);
    if (!s) {
        s = crypto.randomBytes(24).toString('hex');
        await pool.query('INSERT INTO rifa_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING', [clave, s]);
        s = await config(clave);
    }
    return s;
}
const secretoWebhook = () => secreto('webhook_secret');

const fmt = (n) => `#${String(n).padStart(3, '0')}`;
function listaBoletas(nums) {
    const t = nums.map(fmt);
    return t.length === 1 ? t[0] : `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
}
function primerNombre(nombre) {
    const p = String(nombre || '').trim().split(/\s+/)[0] || '';
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// Clientes listos: todas sus boletas de WhatsApp aprobadas, ninguna rechazada,
// y aún sin enviar. Un cliente = una cédula = un solo mensaje.
const SQL_CLIENTES = `
    SELECT cedula, MIN(nombre) AS nombre, MIN(celular) AS celular,
           ARRAY_AGG(numero ORDER BY numero) AS numeros,
           ARRAY_AGG(DISTINCT factura) AS facturas,
           BOOL_AND(revision_estado = 'aprobada') AS aprobadas,
           BOOL_AND(envio_estado = 'pendiente') AS sin_enviar
    FROM rifa_boletas WHERE canal_envio = 'whatsapp' AND NOT anulada
    GROUP BY cedula`;

async function asegurarCampos() {
    let campos = await cargarCamposCache();
    for (const c of CAMPOS_RIFA) {
        if (!campos.find((f) => f.name === c.name)) {
            const r = await manychatRequest('/fb/page/createCustomField', { caption: c.name, type: 'text', description: c.description });
            if (r?.status === 'success' && r.data) campos.push({ ...r.data, name: r.data.name || c.name });
            else throw new Error(`No se pudo crear el campo ${c.name} en ManyChat: ${JSON.stringify(r)}`);
        }
    }
    campos = await cargarCamposCache();
    return campos;
}

/** ¿Canceló la suscripción? Se consulta el contacto justo antes de enviar. */
async function suscripcionCancelada(subscriberId) {
    const r = await manychatRequest(`/fb/subscriber/getInfo?subscriber_id=${subscriberId}`, null, 'GET');
    const d = r?.data || {};
    if (d.status && d.status !== 'active') return `estado ${d.status}`;
    if (d.optin_whatsapp === false || d.whatsapp_optin === false) return 'sin opt-in de WhatsApp';
    return null;
}

async function enviarPlantilla({ subscriberId, cliente, flowNs }) {
    const campos = await asegurarCampos();
    const valores = {
        rifa_nombre: primerNombre(cliente.nombre),
        rifa_boletas: listaBoletas(cliente.numeros),
        rifa_cantidad: String(cliente.numeros.length),
        rifa_facturas: cliente.facturas.join(', '),
    };
    for (const [nombre, valor] of Object.entries(valores)) {
        const campo = campos.find((f) => f.name === nombre);
        const r = await manychatRequest('/fb/subscriber/setCustomField', { subscriber_id: subscriberId, field_id: campo.id, field_value: valor });
        if (r?.status !== 'success') throw new Error(`setCustomField ${nombre}: ${JSON.stringify(r)}`);
    }
    const r = await manychatRequest('/fb/sending/sendFlow', { subscriber_id: subscriberId, flow_ns: flowNs });
    if (r?.status !== 'success') throw new Error(`sendFlow: ${JSON.stringify(r)}`);
}

async function asegurarTokens(numeros) {
    for (const n of numeros) {
        await pool.query('UPDATE rifa_boletas SET token_publico = $2 WHERE numero = $1 AND token_publico IS NULL',
            [n, crypto.randomBytes(24).toString('hex')]);
    }
}

// ── Router admin: /api/admin/rifa/envio ──────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }), rifaAuth);

// GET /resumen — configuración, clientes listos y bitácora de envíos
adminRouter.get('/resumen', async (req, res) => {
    try {
        const { rows } = await pool.query(SQL_CLIENTES);
        const listos = rows.filter((c) => c.aprobadas && c.sin_enviar);
        const sinAprobar = rows.filter((c) => !c.aprobadas);
        const { rows: est } = await pool.query(
            `SELECT envio_estado, COUNT(DISTINCT cedula)::int AS clientes, COUNT(*)::int AS boletas
             FROM rifa_boletas WHERE canal_envio = 'whatsapp' AND NOT anulada GROUP BY 1`
        );
        const { rows: ultimos } = await pool.query(
            `SELECT e.id, e.cedula, e.celular, e.numeros, e.es_prueba, e.estado, e.detalle, e.enviado_en, e.entregado_en,
                    e.respuesta, e.respondido_en, (SELECT MIN(nombre) FROM rifa_boletas b WHERE b.cedula = e.cedula) AS nombre
             FROM (SELECT DISTINCT ON (cedula, es_prueba) * FROM rifa_envios ORDER BY cedula, es_prueba, creado_en DESC) e
             ORDER BY e.creado_en DESC LIMIT 400`
        );
        return res.json({
            success: true,
            configurado: {
                flow_ns: await config('flow_ns'), webhook_secret: await secretoWebhook(), backend_url: process.env.BACKEND_URL || null,
                integracion_secret: await secreto('integracion_secret'),
            },
            clientes_listos: listos.length, boletas_listas: listos.reduce((a, c) => a + c.numeros.length, 0),
            clientes_sin_aprobar: sinAprobar.length,
            por_estado: est, envios: ultimos,
        });
    } catch (err) {
        console.error('[rifa-envio] resumen:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /config — body: { flow_ns }
adminRouter.post('/config', async (req, res) => {
    const flowNs = String(req.body?.flow_ns || '').trim();
    if (!/^content[0-9_]+$/.test(flowNs)) {
        return res.status(400).json({ success: false, error: 'El flow_ns debe verse como content20261023120000_123456' });
    }
    await pool.query(
        `INSERT INTO rifa_config (clave, valor) VALUES ('flow_ns', $1)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [flowNs]
    );
    return res.json({ success: true });
});

async function enviarACliente(cliente, { flowNs, prueba, actor }) {
    const destinoCel = prueba ? NUMERO_COPIA_CONTROL : cliente.celular;
    let subscriberId = prueba ? SUBSCRIBER_ID_COPIA_CONTROL : null;
    const { rows: [envio] } = await pool.query(
        `INSERT INTO rifa_envios (cedula, celular, numeros, es_prueba, estado, actor) VALUES ($1, $2, $3, $4, 'enviando', $5) RETURNING id`,
        [cliente.cedula, destinoCel, cliente.numeros, prueba, actor]
    );
    try {
        if (!subscriberId) {
            // 1) ID de ManyChat registrado a mano para este celular (la API de
            //    ManyChat no siempre encuentra contactos de WhatsApp por número).
            const { rows: m } = await pool.query('SELECT subscriber_id FROM rifa_contactos_manychat WHERE celular = $1',
                [String(cliente.celular).replace(/\D/g, '').slice(-10)]);
            subscriberId = m[0]?.subscriber_id || null;
        }
        let diag = null;
        if (!subscriberId) ({ subscriberId, diagnostico: diag } = await obtenerSubscriberId(cliente.celular));
        if (!subscriberId) {
            const motivo = diag?.crear?.message || diag?.crear?.details?.messages?.[0]?.message || '';
            throw new Error(`No se encontró el contacto en ManyChat${motivo ? ` (${String(motivo).slice(0, 160)})` : ''}. Registra su ID de ManyChat en la bitácora.`);
        }
        await pool.query('UPDATE rifa_envios SET subscriber_id = $2 WHERE id = $1', [envio.id, String(subscriberId)]);

        const cancelado = await suscripcionCancelada(subscriberId);
        if (cancelado && !prueba) {
            await pool.query(`UPDATE rifa_envios SET estado = 'cancelado', detalle = $2 WHERE id = $1`, [envio.id, cancelado]);
            await pool.query(
                `UPDATE rifa_boletas SET canal_envio = 'otro_medio', canal_motivo = $2 WHERE cedula = $1`,
                [cliente.cedula, `Canceló la suscripción de WhatsApp (verificado al enviar: ${cancelado})`]
            );
            return { cedula: cliente.cedula, estado: 'cancelado', detalle: cancelado };
        }

        await asegurarTokens(cliente.numeros);
        await enviarPlantilla({ subscriberId, cliente, flowNs });
        await pool.query(`UPDATE rifa_envios SET estado = 'enviado', enviado_en = NOW() WHERE id = $1`, [envio.id]);
        if (!prueba) {
            await pool.query(
                `UPDATE rifa_boletas SET envio_estado = 'enviado', enviado_en = NOW(), envio_error = NULL WHERE numero = ANY($1::int[])`,
                [cliente.numeros]
            );
            await pool.query(
                `INSERT INTO rifa_eventos (numero, accion, detalle, actor) SELECT unnest($1::int[]), 'whatsapp_enviado', $2, $3`,
                [cliente.numeros, `Plantilla enviada a ${cliente.celular}`, actor]
            );
        }
        return { cedula: cliente.cedula, estado: 'enviado' };
    } catch (err) {
        const msg = String(err.message).slice(0, 500);
        // Si ManyChat/Meta rechaza por suscripción o permiso, pasa a otro medio.
        const esOptOut = /unsubscrib|opt.?in|opt.?out|not subscribed|permission|blocked/i.test(msg);
        await pool.query(`UPDATE rifa_envios SET estado = $2, detalle = $3 WHERE id = $1`, [envio.id, esOptOut ? 'cancelado' : 'fallido', msg]);
        if (!prueba) {
            if (esOptOut) {
                await pool.query(`UPDATE rifa_boletas SET canal_envio = 'otro_medio', canal_motivo = $2 WHERE cedula = $1`,
                    [cliente.cedula, 'WhatsApp rechazó el envío (suscripción/permiso)']);
            } else {
                // Sale de la cola (envio_estado = 'fallido') para que el envío
                // automático no lo reintente sin fin; se reintenta a mano.
                await pool.query(`UPDATE rifa_boletas SET envio_estado = 'fallido', envio_error = $2 WHERE numero = ANY($1::int[])`, [cliente.numeros, msg]);
            }
        }
        return { cedula: cliente.cedula, estado: esOptOut ? 'cancelado' : 'fallido', detalle: msg };
    }
}

// POST /prueba — envía el mensaje del primer cliente listo (o de la cédula
// indicada) a TU número de control, sin marcar nada como enviado.
adminRouter.post('/prueba', async (req, res) => {
    const flowNs = await config('flow_ns');
    if (!flowNs) return res.status(409).json({ success: false, error: 'Primero guarda el flow_ns del flow de ManyChat' });
    const { rows } = await pool.query(SQL_CLIENTES);
    const cliente = rows.find((c) => (req.body?.cedula ? c.cedula === req.body.cedula : c.aprobadas));
    if (!cliente) return res.status(404).json({ success: false, error: 'No hay clientes con boletas aprobadas' });
    const r = await enviarACliente(cliente, { flowNs, prueba: true, actor: req.admin.usuario });
    return res.json({ success: r.estado === 'enviado', resultado: r, enviado_a: NUMERO_COPIA_CONTROL, error: r.detalle });
});

// POST /lote — body: { cantidad } (máx. 15). Envía a los siguientes clientes
// listos, en orden de boleta, con pausa entre mensajes. Se llama repetidamente
// desde la página para avanzar con control (se puede detener en cualquier momento).
adminRouter.post('/lote', async (req, res) => {
    const flowNs = await config('flow_ns');
    if (!flowNs) return res.status(409).json({ success: false, error: 'Primero guarda el flow_ns del flow de ManyChat' });
    const { rows: pruebas } = await pool.query(`SELECT 1 FROM rifa_envios WHERE es_prueba AND entregado_en IS NOT NULL LIMIT 1`);
    if (!pruebas.length) {
        return res.status(409).json({ success: false, error: 'Antes de enviar a clientes, haz una prueba a tu número y toca "Ver mis boletas" para comprobar que llegan.' });
    }
    const cantidad = Math.min(Math.max(Number(req.body?.cantidad) || 10, 1), 15);
    const { rows } = await pool.query(SQL_CLIENTES);
    const listos = rows.filter((c) => c.aprobadas && c.sin_enviar)
        .sort((a, b) => a.numeros[0] - b.numeros[0]).slice(0, cantidad);
    const resultados = [];
    for (const c of listos) {
        resultados.push({ nombre: c.nombre, numeros: c.numeros, ...(await enviarACliente(c, { flowNs, prueba: false, actor: req.admin.usuario })) });
        await new Promise((r) => setTimeout(r, 1500));
    }
    return res.json({ success: true, resultados });
});

// POST /contacto-manychat — body: { cedula, subscriber_id }. Registra a mano el
// ID de ManyChat del cliente (ManyChat → Contacts → abrir contacto → ícono de ID)
// y devuelve sus boletas fallidas a la cola.
adminRouter.post('/contacto-manychat', async (req, res) => {
    const id = String(req.body?.subscriber_id || '').trim();
    if (!/^\d{5,20}$/.test(id)) return res.status(400).json({ success: false, error: 'El ID de ManyChat debe ser solo números.' });
    const { rows: [c] } = await pool.query(
        `SELECT MIN(celular) AS celular FROM rifa_boletas WHERE cedula = $1 AND canal_envio = 'whatsapp'`, [String(req.body?.cedula || '')]
    );
    if (!c?.celular) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
    const cel = c.celular.replace(/\D/g, '').slice(-10);
    await pool.query(
        `INSERT INTO rifa_contactos_manychat (celular, subscriber_id, actor) VALUES ($1, $2, $3)
         ON CONFLICT (celular) DO UPDATE SET subscriber_id = EXCLUDED.subscriber_id, actor = EXCLUDED.actor, actualizado_en = NOW()`,
        [cel, id, req.admin.usuario]
    );
    const { rowCount } = await pool.query(
        `UPDATE rifa_boletas SET envio_estado = 'pendiente', envio_error = NULL
         WHERE cedula = $1 AND envio_estado = 'fallido' AND canal_envio = 'whatsapp' AND NOT anulada`, [String(req.body.cedula)]
    );
    return res.json({ success: true, boletas_en_cola: rowCount });
});

// POST /reintentar-fallidos — devuelve a la cola los clientes con envío fallido
// (por ejemplo, después de corregir su contacto en ManyChat).
adminRouter.post('/reintentar-fallidos', async (req, res) => {
    const { rows } = await pool.query(
        `UPDATE rifa_boletas SET envio_estado = 'pendiente', envio_error = NULL
         WHERE envio_estado = 'fallido' AND canal_envio = 'whatsapp' AND NOT anulada RETURNING cedula`
    );
    return res.json({ success: true, clientes: new Set(rows.map((r) => r.cedula)).size, boletas: rows.length });
});

// ── Router público: /api/rifa ────────────────────────────────────────────────
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

// GET /boleta/:token.jpg — imagen de una boleta (token aleatorio, no adivinable)
publicRouter.get('/boleta/:token.jpg', async (req, res) => {
    if (!/^[0-9a-f]{48}$/.test(req.params.token)) return res.status(404).end();
    const { rows } = await pool.query('SELECT imagen FROM rifa_boletas WHERE token_publico = $1', [req.params.token]);
    if (!rows.length) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.send(rows[0].imagen);
});

async function verificarSecreto(req, res, next) {
    const s = await secretoWebhook();
    const recibido = String(req.get('X-Rifa-Secret') || req.body?.secret || '');
    if (recibido.length !== s.length || !crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(s))) {
        return res.status(401).json({ success: false });
    }
    return next();
}

async function ultimoEnvio(subscriberId) {
    const { rows } = await pool.query(
        `SELECT * FROM rifa_envios WHERE subscriber_id = $1 AND estado IN ('enviado', 'entregado') ORDER BY creado_en DESC LIMIT 1`,
        [String(subscriberId || '')]
    );
    return rows[0] || null;
}

// POST /webhook/ver — lo llama el flow al tocar "Ver mis boletas".
// body: { subscriber_id }. Envía las imágenes y registra la entrega.
publicRouter.post('/webhook/ver', verificarSecreto, async (req, res) => {
    try {
        const envio = await ultimoEnvio(req.body?.subscriber_id);
        if (!envio) return res.json({ success: false, mensaje: 'sin_envio' });
        const { rows } = await pool.query(
            'SELECT numero, token_publico FROM rifa_boletas WHERE numero = ANY($1::int[]) ORDER BY numero', [envio.numeros]
        );
        const base = process.env.BACKEND_URL;
        const messages = rows.map((b) => ({ type: 'image', url: `${base}/api/rifa/boleta/${b.token_publico}.jpg` }));
        const r = await manychatRequest('/fb/sending/sendContent', {
            subscriber_id: envio.subscriber_id,
            data: { version: 'v2', content: { type: 'whatsapp', messages } },
        });
        if (r?.status !== 'success') throw new Error(`sendContent: ${JSON.stringify(r)}`);
        await pool.query(`UPDATE rifa_envios SET estado = 'entregado', entregado_en = COALESCE(entregado_en, NOW()) WHERE id = $1`, [envio.id]);
        if (!envio.es_prueba) {
            await pool.query(
                `UPDATE rifa_boletas SET envio_estado = 'entregado', entregado_en = COALESCE(entregado_en, NOW()) WHERE numero = ANY($1::int[])`,
                [envio.numeros]
            );
            await pool.query(
                `INSERT INTO rifa_eventos (numero, accion, detalle, actor) SELECT unnest($1::int[]), 'whatsapp_entregado', 'El cliente pidió ver sus boletas y se le enviaron las imágenes', 'cliente'`,
                [envio.numeros]
            );
        }
        // Espera breve para que las imágenes lleguen antes de la pregunta del flow.
        await new Promise((r2) => setTimeout(r2, 2500));
        return res.json({ success: true, cantidad: rows.length });
    } catch (err) {
        console.error('[rifa-envio] webhook ver:', err.message);
        return res.status(500).json({ success: false });
    }
});

// POST /webhook/confirmar — body: { subscriber_id, respuesta: 'ok' | 'error' }
publicRouter.post('/webhook/confirmar', verificarSecreto, async (req, res) => {
    try {
        const respuesta = req.body?.respuesta === 'ok' ? 'ok' : 'error';
        const envio = await ultimoEnvio(req.body?.subscriber_id);
        if (!envio) return res.json({ success: false, mensaje: 'sin_envio' });
        await pool.query(`UPDATE rifa_envios SET respuesta = $2, respondido_en = NOW() WHERE id = $1`, [envio.id, respuesta]);
        if (!envio.es_prueba) {
            await pool.query(
                `UPDATE rifa_boletas SET envio_estado = $2, confirmado_en = NOW() WHERE numero = ANY($1::int[])`,
                [envio.numeros, respuesta === 'ok' ? 'confirmado' : 'error_datos']
            );
            await pool.query(
                `INSERT INTO rifa_eventos (numero, accion, detalle, actor) SELECT unnest($1::int[]), $2, NULL, 'cliente'`,
                [envio.numeros, respuesta === 'ok' ? 'cliente_confirmo' : 'cliente_reporto_error']
            );
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('[rifa-envio] webhook confirmar:', err.message);
        return res.status(500).json({ success: false });
    }
});

module.exports = { adminRouter, publicRouter };
