const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const rifaAuth = require('../middleware/rifaAuth');
const { enviarCorreoBoletasRifa } = require('../services/emailService');

// Envío de boletas por CORREO a los clientes que no reciben por WhatsApp (sin
// celular o que cancelaron la suscripción) y sí tienen correo.
// Mismas reglas que WhatsApp: prueba obligatoria a comercial@ antes de enviar,
// un correo por cliente con todas sus boletas, un fallo saca al cliente de la
// cola (no se reintenta solo) y el cliente confirma sus datos con un enlace.

const CORREO_PRUEBA = process.env.CORREO_RECUPERACION_ACCESO || 'comercial@retoucherie.com.co';
const BACKEND = () => process.env.BACKEND_URL || 'https://polla-backend-cz6u.onrender.com';

pool.query(`
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS correo_estado VARCHAR(20) NOT NULL DEFAULT 'pendiente';
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS correo_enviado_en TIMESTAMPTZ;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS correo_confirmado_en TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS rifa_envios_correo (
        id SERIAL PRIMARY KEY,
        cedula VARCHAR(30) NOT NULL,
        correo VARCHAR(200) NOT NULL,
        numeros INTEGER[] NOT NULL,
        es_prueba BOOLEAN NOT NULL DEFAULT FALSE,
        estado VARCHAR(20) NOT NULL,
        detalle TEXT,
        token CHAR(48) UNIQUE,
        enviado_en TIMESTAMPTZ,
        respuesta VARCHAR(20),
        respondido_en TIMESTAMPTZ,
        actor VARCHAR(80),
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`).catch((err) => console.error('[rifa-correo] Error migrando:', err.message));

// Clientes con boletas que van por otro medio y tienen correo.
const SQL_CLIENTES = `
    SELECT cedula, MIN(nombre) AS nombre, MIN(correo) AS correo,
           ARRAY_AGG(numero ORDER BY numero) AS numeros, ARRAY_AGG(DISTINCT factura) AS facturas,
           BOOL_AND(revision_estado = 'aprobada') AS aprobadas,
           BOOL_AND(correo_estado = 'pendiente') AS sin_enviar,
           MIN(canal_motivo) AS motivo
    FROM rifa_boletas
    WHERE canal_envio = 'otro_medio' AND NOT anulada AND correo IS NOT NULL AND correo <> ''
    GROUP BY cedula`;

const correoValido = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(c || '').trim());
// Alegra guarda muchos nombres con el apellido primero ("SALCEDO DE CORTES ALBA"),
// así que no se puede saber cuál es el nombre de pila: se saluda con el nombre
// completo en formato título.
const nombreSaludo = (n) => String(n || '').trim().toLowerCase().split(/\s+/)
    .map((w) => (['de', 'del', 'la', 'las', 'los', 'y'].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

async function enviarACliente(cliente, { prueba, actor }) {
    const destino = prueba ? CORREO_PRUEBA : String(cliente.correo).trim();
    const token = crypto.randomBytes(24).toString('hex');
    const { rows: [envio] } = await pool.query(
        `INSERT INTO rifa_envios_correo (cedula, correo, numeros, es_prueba, estado, token, actor)
         VALUES ($1, $2, $3, $4, 'enviando', $5, $6) RETURNING id`,
        [cliente.cedula, destino, cliente.numeros, prueba, token, actor]
    );
    try {
        if (!correoValido(destino)) throw new Error(`Correo inválido: ${destino}`);
        const { rows: imgs } = await pool.query(
            'SELECT numero, imagen FROM rifa_boletas WHERE numero = ANY($1::int[]) ORDER BY numero', [cliente.numeros]
        );
        const info = await enviarCorreoBoletasRifa({
            destinatario: destino,
            nombre: nombreSaludo(cliente.nombre),
            numeros: cliente.numeros,
            facturas: cliente.facturas,
            adjuntos: imgs.map((b) => ({ filename: `boleta_${String(b.numero).padStart(3, '0')}.jpg`, content: b.imagen, contentType: 'image/jpeg' })),
            linkOk: `${BACKEND()}/api/rifa/correo/confirmar/${token}?r=ok`,
            linkError: `${BACKEND()}/api/rifa/correo/confirmar/${token}?r=error`,
            esPrueba: prueba,
        });
        const aceptado = (info.accepted || []).length > 0;
        if (!aceptado) throw new Error(`El servidor de correo no aceptó el destinatario: ${JSON.stringify(info.rejected)}`);
        await pool.query(`UPDATE rifa_envios_correo SET estado = 'enviado', enviado_en = NOW(), detalle = $2 WHERE id = $1`,
            [envio.id, String(info.response || '').slice(0, 200)]);
        if (!prueba) {
            await pool.query(`UPDATE rifa_boletas SET correo_estado = 'enviado', correo_enviado_en = NOW() WHERE numero = ANY($1::int[])`, [cliente.numeros]);
            await pool.query(
                `INSERT INTO rifa_eventos (numero, accion, detalle, actor) SELECT unnest($1::int[]), 'correo_enviado', $2, $3`,
                [cliente.numeros, `Boletas enviadas por correo a ${destino}`, actor]
            );
        }
        return { cedula: cliente.cedula, nombre: cliente.nombre, correo: destino, estado: 'enviado', respuesta_smtp: String(info.response || '').slice(0, 120) };
    } catch (err) {
        const msg = `${err.code || ''} ${err.message}`.trim().slice(0, 400);
        await pool.query(`UPDATE rifa_envios_correo SET estado = 'fallido', detalle = $2 WHERE id = $1`, [envio.id, msg]);
        if (!prueba) await pool.query(`UPDATE rifa_boletas SET correo_estado = 'fallido' WHERE numero = ANY($1::int[])`, [cliente.numeros]);
        return { cedula: cliente.cedula, nombre: cliente.nombre, correo: destino, estado: 'fallido', detalle: msg };
    }
}

async function primerClienteParaPrueba() {
    const { rows } = await pool.query(SQL_CLIENTES);
    return rows.filter((c) => c.aprobadas).sort((a, b) => a.numeros[0] - b.numeros[0])[0] || null;
}

// ── Admin: /api/admin/rifa/correo ────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }), rifaAuth);

adminRouter.get('/resumen', async (req, res) => {
    try {
        const { rows } = await pool.query(SQL_CLIENTES);
        const { rows: est } = await pool.query(
            `SELECT correo_estado, COUNT(DISTINCT cedula)::int AS clientes, COUNT(*)::int AS boletas
             FROM rifa_boletas WHERE canal_envio = 'otro_medio' AND NOT anulada AND correo IS NOT NULL AND correo <> '' GROUP BY 1`
        );
        const { rows: [sin] } = await pool.query(
            `SELECT COUNT(DISTINCT cedula)::int AS clientes, COUNT(*)::int AS boletas FROM rifa_boletas
             WHERE canal_envio = 'otro_medio' AND NOT anulada AND (correo IS NULL OR correo = '')`
        );
        const { rows: envios } = await pool.query(
            `SELECT e.id, e.cedula, e.correo, e.numeros, e.es_prueba, e.estado, e.detalle, e.enviado_en, e.respuesta, e.respondido_en,
                    (SELECT MIN(nombre) FROM rifa_boletas b WHERE b.cedula = e.cedula) AS nombre
             FROM (SELECT DISTINCT ON (cedula, es_prueba) * FROM rifa_envios_correo ORDER BY cedula, es_prueba, creado_en DESC) e
             ORDER BY e.creado_en DESC LIMIT 300`
        );
        const listos = rows.filter((c) => c.aprobadas && c.sin_enviar);
        return res.json({
            success: true, correo_prueba: CORREO_PRUEBA,
            clientes_con_correo: rows.length, clientes_listos: listos.length, boletas_listas: listos.reduce((a, c) => a + c.numeros.length, 0),
            sin_correo: sin, por_estado: est, envios,
            // La prueba solo cuenta si se tocó un botón del correo: prueba que llegó de verdad
            // (Brevo responde "aceptado" aunque luego no lo entregue, p. ej. sin créditos).
            prueba_ok: envios.some((e) => e.es_prueba && e.estado === 'enviado' && e.respuesta),
            prueba_pendiente: envios.some((e) => e.es_prueba && e.estado === 'enviado' && !e.respuesta),
        });
    } catch (err) {
        console.error('[rifa-correo] resumen:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

adminRouter.post('/prueba', async (req, res) => {
    const cliente = await primerClienteParaPrueba();
    if (!cliente) return res.status(404).json({ success: false, error: 'No hay clientes con correo y boletas aprobadas' });
    const r = await enviarACliente(cliente, { prueba: true, actor: req.admin.usuario });
    return res.json({ success: r.estado === 'enviado', resultado: r, error: r.detalle });
});

adminRouter.post('/lote', async (req, res) => {
    const { rows: p } = await pool.query(`SELECT 1 FROM rifa_envios_correo WHERE es_prueba AND estado = 'enviado' AND respuesta IS NOT NULL LIMIT 1`);
    if (!p.length) return res.status(409).json({ success: false, error: 'Abre el correo de prueba en comercial@ y toca uno de sus botones: así se confirma que llegó.' });
    const cantidad = Math.min(Math.max(Number(req.body?.cantidad) || 10, 1), 10);
    const { rows } = await pool.query(SQL_CLIENTES);
    const listos = rows.filter((c) => c.aprobadas && c.sin_enviar).sort((a, b) => a.numeros[0] - b.numeros[0]).slice(0, cantidad);
    const resultados = [];
    for (const c of listos) {
        resultados.push(await enviarACliente(c, { prueba: false, actor: req.admin.usuario }));
        await new Promise((r) => setTimeout(r, 1200));
    }
    return res.json({ success: true, resultados });
});

adminRouter.post('/reintentar-fallidos', async (req, res) => {
    const { rowCount } = await pool.query(
        `UPDATE rifa_boletas SET correo_estado = 'pendiente' WHERE correo_estado = 'fallido' AND canal_envio = 'otro_medio' AND NOT anulada`
    );
    return res.json({ success: true, boletas: rowCount });
});

// ── Público: confirmación desde el correo (/api/rifa/correo/confirmar/:token) ─
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const pagina = (titulo, texto) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title></head><body style="margin:0;background:#09090b;color:#fff;font-family:Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px">
<div style="max-width:420px"><h1 style="color:#f59e0b">${titulo}</h1><p style="color:#d4d4d8;line-height:1.5">${texto}</p>
<p style="color:#71717a;font-size:12px;margin-top:32px">La Retoucherie de Manuela · Rifa iPhone 18 Pro · Sorteo 20 de diciembre de 2026</p></div></body></html>`;

publicRouter.get('/confirmar/:token', async (req, res) => {
    const ok = req.query.r === 'ok';
    if (!/^[0-9a-f]{48}$/.test(req.params.token)) return res.status(404).send(pagina('Enlace inválido', 'Este enlace no es válido.'));
    const { rows } = await pool.query('SELECT * FROM rifa_envios_correo WHERE token = $1', [req.params.token]);
    const e = rows[0];
    if (!e) return res.status(404).send(pagina('Enlace inválido', 'Este enlace no es válido o ya venció.'));
    await pool.query(`UPDATE rifa_envios_correo SET respuesta = $2, respondido_en = NOW() WHERE id = $1`, [e.id, ok ? 'ok' : 'error']);
    if (!e.es_prueba) {
        await pool.query(`UPDATE rifa_boletas SET correo_estado = $2, correo_confirmado_en = NOW() WHERE numero = ANY($1::int[])`,
            [e.numeros, ok ? 'confirmado' : 'error_datos']);
        await pool.query(`INSERT INTO rifa_eventos (numero, accion, actor) SELECT unnest($1::int[]), $2, 'cliente'`,
            [e.numeros, ok ? 'cliente_confirmo_correo' : 'cliente_reporto_error_correo']);
    }
    return res.send(ok
        ? pagina('¡Listo! 🍀', 'Tus boletas quedaron confirmadas. Mucha suerte en el sorteo del 20 de diciembre.')
        : pagina('Gracias por avisarnos', 'Un asesor de La Retoucherie te contactará para corregir tus datos. También puedes escribirnos por WhatsApp al +57 323 383 3253.'));
});

module.exports = { adminRouter, publicRouter, enviarACliente, primerClienteParaPrueba };
