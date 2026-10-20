const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');

// Rifa iPhone 18 Pro: revisión y aprobación de boletas antes del envío por
// WhatsApp. Las boletas (datos + imagen auditada) se cargan desde el script
// rifa-iphone/cargar_boletas.py; aquí el admin las revisa en lotes de 10, en
// el orden de envío (número de boleta), y aprueba o rechaza cada una.

const TAM_LOTE = 10;

// Límite propio: revisar un lote son ~11 solicitudes (lista + 10 imágenes),
// así que el adminLimiter general (50/15 min) no alcanza.
const rifaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 800,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' },
});

// Auto-migración: crea las tablas si no existen al arrancar el servidor
pool.query(`
    CREATE TABLE IF NOT EXISTS rifa_boletas (
        numero INTEGER PRIMARY KEY,
        factura VARCHAR(40) NOT NULL,
        boleta_de_factura INTEGER NOT NULL,
        fecha_factura DATE NOT NULL,
        sede VARCHAR(30) NOT NULL,
        nombre VARCHAR(200) NOT NULL,
        cedula VARCHAR(30) NOT NULL,
        celular VARCHAR(20),
        correo VARCHAR(200),
        imagen BYTEA NOT NULL,
        imagen_mime VARCHAR(30) NOT NULL DEFAULT 'image/jpeg',
        imagen_sha256 CHAR(64) NOT NULL,
        observacion_auditoria TEXT,
        revision_estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        revision_nota TEXT,
        revisado_por VARCHAR(80),
        revisado_en TIMESTAMPTZ,
        canal_envio VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
        canal_motivo TEXT,
        envio_estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        enviado_en TIMESTAMPTZ,
        confirmado_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (factura, boleta_de_factura),
        CHECK (revision_estado IN ('pendiente', 'aprobada', 'rechazada')),
        CHECK (canal_envio IN ('whatsapp', 'otro_medio'))
    );
    CREATE TABLE IF NOT EXISTS rifa_eventos (
        id SERIAL PRIMARY KEY,
        numero INTEGER REFERENCES rifa_boletas(numero),
        accion VARCHAR(40) NOT NULL,
        detalle TEXT,
        actor VARCHAR(80),
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`).catch((err) => console.error('[rifa] Error creando tablas:', err.message));

// Última vez que se cruzó la base contra la lista de contactos que cancelaron
// la suscripción de WhatsApp en ManyChat (la registra cargar_boletas.py).
async function ultimaVerificacionCancelados() {
    const { rows } = await pool.query(
        `SELECT creado_en, detalle, actor FROM rifa_eventos
         WHERE accion = 'verificacion_cancelados' ORDER BY creado_en DESC LIMIT 1`
    );
    return rows[0] || null;
}

const router = express.Router();
router.use(rifaLimiter, adminAuth);

const CAMPOS_LISTA = `numero, factura, boleta_de_factura, to_char(fecha_factura, 'YYYY-MM-DD') AS fecha_factura,
    sede, nombre, cedula, celular, correo, imagen_sha256, observacion_auditoria,
    revision_estado, revision_nota, revisado_por, revisado_en, canal_envio, canal_motivo, envio_estado`;

// GET /api/admin/rifa/resumen — totales y estado de cada lote
router.get('/resumen', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT ((numero - 1) / $1) + 1 AS lote,
                    MIN(numero) AS desde, MAX(numero) AS hasta, COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE revision_estado = 'aprobada')::int AS aprobadas,
                    COUNT(*) FILTER (WHERE revision_estado = 'rechazada')::int AS rechazadas,
                    COUNT(*) FILTER (WHERE celular IS NULL OR celular = '')::int AS sin_celular,
                    COUNT(*) FILTER (WHERE canal_envio = 'otro_medio')::int AS otro_medio,
                    MAX(revisado_en) AS ultima_revision
             FROM rifa_boletas GROUP BY 1 ORDER BY 1`,
            [TAM_LOTE]
        );
        const tot = rows.reduce((a, l) => ({
            total: a.total + l.total, aprobadas: a.aprobadas + l.aprobadas,
            rechazadas: a.rechazadas + l.rechazadas, sin_celular: a.sin_celular + l.sin_celular,
            otro_medio: a.otro_medio + l.otro_medio,
        }), { total: 0, aprobadas: 0, rechazadas: 0, sin_celular: 0, otro_medio: 0 });
        const verif = await ultimaVerificacionCancelados();
        return res.json({ success: true, tam_lote: TAM_LOTE, totales: tot, lotes: rows, verificacion_cancelados: verif });
    } catch (err) {
        console.error('[rifa] resumen:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/rifa/lotes/:n — boletas del lote (sin imagen)
router.get('/lotes/:n', async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ success: false, error: 'Lote inválido' });
    try {
        const { rows } = await pool.query(
            `SELECT ${CAMPOS_LISTA} FROM rifa_boletas WHERE numero BETWEEN $1 AND $2 ORDER BY numero`,
            [(n - 1) * TAM_LOTE + 1, n * TAM_LOTE]
        );
        return res.json({ success: true, lote: n, boletas: rows });
    } catch (err) {
        console.error('[rifa] lote:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/rifa/boletas/:numero/imagen — la imagen auditada exacta
router.get('/boletas/:numero/imagen', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT imagen, imagen_mime, imagen_sha256 FROM rifa_boletas WHERE numero = $1',
            [Number(req.params.numero)]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'No existe' });
        res.set('Content-Type', rows[0].imagen_mime);
        res.set('Cache-Control', 'private, max-age=600');
        res.set('X-Imagen-Sha256', rows[0].imagen_sha256);
        return res.send(rows[0].imagen);
    } catch (err) {
        console.error('[rifa] imagen:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/rifa/lotes/:n/revision
// body: { decisiones: [{ numero, estado: 'aprobada'|'rechazada', nota? }] }
// Registra quién y cuándo revisó cada boleta. Solo acepta números del lote.
router.post('/lotes/:n/revision', async (req, res) => {
    const n = Number(req.params.n);
    const decisiones = Array.isArray(req.body?.decisiones) ? req.body.decisiones : [];
    const desde = (n - 1) * TAM_LOTE + 1;
    const hasta = n * TAM_LOTE;
    if (!Number.isInteger(n) || n < 1 || !decisiones.length) {
        return res.status(400).json({ success: false, error: 'Faltan decisiones' });
    }
    for (const d of decisiones) {
        if (!Number.isInteger(d.numero) || d.numero < desde || d.numero > hasta) {
            return res.status(400).json({ success: false, error: `La boleta ${d.numero} no pertenece al lote ${n}` });
        }
        if (!['aprobada', 'rechazada'].includes(d.estado)) {
            return res.status(400).json({ success: false, error: `Estado inválido para la boleta ${d.numero}` });
        }
        if (d.estado === 'rechazada' && !String(d.nota || '').trim()) {
            return res.status(400).json({ success: false, error: `Indica el motivo del rechazo de la boleta ${d.numero}` });
        }
    }
    // Paso crítico: no se autoriza ningún envío sin haber verificado antes la
    // lista de cancelados de WhatsApp.
    if (decisiones.some((d) => d.estado === 'aprobada') && !(await ultimaVerificacionCancelados())) {
        return res.status(409).json({
            success: false,
            error: 'Falta verificar la lista de clientes que cancelaron la suscripción de WhatsApp. No se puede aprobar todavía.',
        });
    }
    const actor = req.admin.usuario;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const d of decisiones) {
            const nota = d.estado === 'rechazada' ? String(d.nota).trim().slice(0, 500) : null;
            await client.query(
                `UPDATE rifa_boletas SET revision_estado = $2, revision_nota = $3,
                        revisado_por = $4, revisado_en = NOW()
                 WHERE numero = $1`,
                [d.numero, d.estado, nota, actor]
            );
            await client.query(
                'INSERT INTO rifa_eventos (numero, accion, detalle, actor) VALUES ($1, $2, $3, $4)',
                [d.numero, d.estado === 'aprobada' ? 'revision_aprobada' : 'revision_rechazada', nota, actor]
            );
        }
        await client.query('COMMIT');
        return res.json({ success: true, actualizadas: decisiones.length });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[rifa] revision:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

// POST /api/admin/rifa/boletas/:numero/canal — body: { canal: 'whatsapp'|'otro_medio', motivo }
// Cambia el canal de envío de TODAS las boletas del mismo cliente (misma cédula),
// porque a cada cliente se le envía un solo mensaje con todas sus boletas.
router.post('/boletas/:numero/canal', async (req, res) => {
    const numero = Number(req.params.numero);
    const { canal } = req.body || {};
    const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
    if (!['whatsapp', 'otro_medio'].includes(canal)) {
        return res.status(400).json({ success: false, error: 'Canal inválido' });
    }
    if (canal === 'otro_medio' && !motivo) {
        return res.status(400).json({ success: false, error: 'Indica el motivo' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: b } = await client.query('SELECT cedula, celular FROM rifa_boletas WHERE numero = $1', [numero]);
        if (!b.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'No existe' });
        }
        if (canal === 'whatsapp' && !b[0].celular) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Esta boleta no tiene celular' });
        }
        const { rows } = await client.query(
            `UPDATE rifa_boletas SET canal_envio = $2, canal_motivo = $3
             WHERE cedula = $1 RETURNING numero`,
            [b[0].cedula, canal, canal === 'otro_medio' ? motivo : null]
        );
        for (const r of rows) {
            await client.query(
                'INSERT INTO rifa_eventos (numero, accion, detalle, actor) VALUES ($1, $2, $3, $4)',
                [r.numero, `canal_${canal}`, motivo || null, req.admin.usuario]
            );
        }
        await client.query('COMMIT');
        return res.json({ success: true, boletas: rows.map((r) => r.numero) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[rifa] canal:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
