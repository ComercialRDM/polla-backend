const express = require('express');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { enviarCorreoChecklist } = require('../services/emailService');

const router = express.Router();
router.use(adminAuth);

// ── Utilidad: fecha Colombia ──────────────────────────────────────────────────
function fechaHoyBogota() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// ── GET /checklist/categorias ─────────────────────────────────────────────────
// Devuelve categorías activas con sus actividades activas y el conteo de checks
// para la fecha solicitada (default: hoy).
router.get('/categorias', async (req, res) => {
    const fecha = req.query.fecha || fechaHoyBogota();
    try {
        const { rows: cats } = await pool.query(
            `SELECT id, nombre, color, orden FROM checklist_categorias WHERE activa = TRUE ORDER BY orden, id`
        );
        const { rows: acts } = await pool.query(
            `SELECT a.id, a.categoria_id, a.titulo, a.descripcion, a.prioridad,
                    a.obligatoria, a.orden, a.impacto_esperado,
                    COALESCE(c.completada, FALSE) AS completada,
                    c.nota, c.valor_ejecutado
             FROM checklist_actividades a
             LEFT JOIN checklist_checks c ON c.actividad_id = a.id AND c.fecha = $1
             WHERE a.activa = TRUE
             ORDER BY a.categoria_id, a.orden, a.id`,
            [fecha]
        );
        const result = cats.map((cat) => ({
            ...cat,
            actividades: acts.filter((a) => a.categoria_id === cat.id),
        }));
        res.json({ success: true, categorias: result, fecha });
    } catch (err) {
        console.error('GET /checklist/categorias:', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── GET /checklist/matriz?dias=7 ──────────────────────────────────────────────
// Devuelve actividades × últimos N días para la vista matriz.
router.get('/matriz', async (req, res) => {
    const dias = Math.min(Number(req.query.dias) || 7, 30);
    try {
        const { rows: acts } = await pool.query(
            `SELECT a.id, a.titulo, a.categoria_id, cat.nombre AS categoria_nombre, cat.color
             FROM checklist_actividades a
             JOIN checklist_categorias cat ON cat.id = a.categoria_id
             WHERE a.activa = TRUE AND cat.activa = TRUE
             ORDER BY cat.orden, a.orden, a.id`
        );
        const { rows: checks } = await pool.query(
            `SELECT actividad_id, fecha::text, completada, nota
             FROM checklist_checks
             WHERE fecha >= CURRENT_DATE - ($1 - 1) * INTERVAL '1 day'
             ORDER BY fecha`,
            [dias]
        );
        // Construir mapa actividad_id → { fecha: {completada, nota} }
        const mapa = {};
        checks.forEach(({ actividad_id, fecha, completada, nota }) => {
            if (!mapa[actividad_id]) mapa[actividad_id] = {};
            mapa[actividad_id][fecha] = { completada, nota };
        });
        // Generar columnas de fechas
        const fechas = [];
        for (let i = dias - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            fechas.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
        }
        res.json({ success: true, actividades: acts, fechas, checks: mapa });
    } catch (err) {
        console.error('GET /checklist/matriz:', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── GET /checklist/resumen-dia?fecha= ────────────────────────────────────────
// KPIs del día: avance %, completadas, pendientes, bloqueadas (nota "bloqueo"),
// mejor categoría, ingresos del día desde transacciones.
router.get('/resumen-dia', async (req, res) => {
    const fecha = req.query.fecha || fechaHoyBogota();
    try {
        const { rows: totales } = await pool.query(
            `SELECT
               COUNT(a.id)::int AS total,
               COUNT(c.id) FILTER (WHERE c.completada = TRUE)::int AS completadas,
               COUNT(c.id) FILTER (WHERE c.nota ILIKE '%bloqueo%' AND (c.completada = FALSE OR c.completada IS NULL))::int AS bloqueadas
             FROM checklist_actividades a
             JOIN checklist_categorias cat ON cat.id = a.categoria_id AND cat.activa = TRUE
             LEFT JOIN checklist_checks c ON c.actividad_id = a.id AND c.fecha = $1
             WHERE a.activa = TRUE`,
            [fecha]
        );
        const { rows: porCat } = await pool.query(
            `SELECT cat.id, cat.nombre, cat.color,
               COUNT(a.id)::int AS total,
               COUNT(c.id) FILTER (WHERE c.completada = TRUE)::int AS completadas
             FROM checklist_categorias cat
             JOIN checklist_actividades a ON a.categoria_id = cat.id AND a.activa = TRUE
             LEFT JOIN checklist_checks c ON c.actividad_id = a.id AND c.fecha = $1
             WHERE cat.activa = TRUE
             GROUP BY cat.id, cat.nombre, cat.color
             ORDER BY (COUNT(c.id) FILTER (WHERE c.completada = TRUE))::float / NULLIF(COUNT(a.id), 0) DESC`,
            [fecha]
        );
        const { rows: ingresos } = await pool.query(
            `SELECT COALESCE(SUM(valor), 0)::bigint AS total
             FROM transacciones
             WHERE estado_pago = 'APROBADO'
               AND es_test = FALSE
               AND DATE(created_at AT TIME ZONE 'America/Bogota') = $1`,
            [fecha]
        );
        const t = totales[0];
        const pendientes = t.total - t.completadas - t.bloqueadas;
        const pct = t.total > 0 ? Math.round((t.completadas / t.total) * 100) : 0;
        const categoriasTrabajadas = porCat.filter((c) => c.completadas > 0).length;
        const mejorCategoria = porCat[0] || null;

        res.json({
            success: true, fecha,
            total: t.total, completadas: t.completadas,
            pendientes: Math.max(0, pendientes), bloqueadas: t.bloqueadas,
            pct, categoriasTrabajadas,
            mejorCategoria,
            ingresosHoy: Number(ingresos[0].total),
            porCategoria: porCat,
        });
    } catch (err) {
        console.error('GET /checklist/resumen-dia:', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── POST /checklist/check ─────────────────────────────────────────────────────
// Marcar/desmarcar actividad para una fecha (upsert).
router.post('/check', async (req, res) => {
    const { actividad_id, fecha, completada, nota, valor_ejecutado } = req.body;
    if (!actividad_id || !fecha) return res.status(400).json({ success: false, error: 'Faltan campos' });
    try {
        await pool.query(
            `INSERT INTO checklist_checks (actividad_id, fecha, completada, nota, valor_ejecutado, admin_usuario_id, actualizado_en)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (actividad_id, fecha) DO UPDATE
               SET completada = EXCLUDED.completada,
                   nota = EXCLUDED.nota,
                   valor_ejecutado = EXCLUDED.valor_ejecutado,
                   admin_usuario_id = EXCLUDED.admin_usuario_id,
                   actualizado_en = now()`,
            [actividad_id, fecha, completada ?? false, nota ?? null, valor_ejecutado ?? null, req.admin.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('POST /checklist/check:', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── GET /checklist/nota?fecha=&tipo= ─────────────────────────────────────────
router.get('/nota', async (req, res) => {
    const fecha = req.query.fecha || fechaHoyBogota();
    const tipo = req.query.tipo;
    if (!tipo) return res.status(400).json({ success: false, error: 'Falta tipo' });
    try {
        const { rows } = await pool.query(
            `SELECT id, contenido, enviado_en, creado_en, actualizado_en FROM checklist_notas_dia WHERE fecha = $1 AND tipo = $2`,
            [fecha, tipo]
        );
        res.json({ success: true, nota: rows[0] || null, fecha, tipo });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── POST /checklist/nota ──────────────────────────────────────────────────────
// Guardar borrador (enviar=false) o enviar por correo (enviar=true).
router.post('/nota', async (req, res) => {
    const { fecha, tipo, contenido, enviar } = req.body;
    if (!fecha || !tipo || !contenido) return res.status(400).json({ success: false, error: 'Faltan campos' });
    if (!['standup', 'cierre'].includes(tipo)) return res.status(400).json({ success: false, error: 'Tipo inválido' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO checklist_notas_dia (fecha, tipo, contenido, admin_usuario_id, enviado_en, actualizado_en)
             VALUES ($1, $2, $3, $4, NULL, now())
             ON CONFLICT (fecha, tipo) DO UPDATE
               SET contenido = EXCLUDED.contenido,
                   admin_usuario_id = EXCLUDED.admin_usuario_id,
                   actualizado_en = now()
             RETURNING id, enviado_en`,
            [fecha, tipo, contenido, req.admin.id]
        );
        let enviado_en = rows[0].enviado_en;
        if (enviar) {
            await enviarCorreoChecklist({ tipo, fecha, contenido, usuario: req.admin.usuario });
            enviado_en = new Date();
            await pool.query(
                `UPDATE checklist_notas_dia SET enviado_en = now() WHERE fecha = $1 AND tipo = $2`,
                [fecha, tipo]
            );
        }
        res.json({ success: true, enviado_en });
    } catch (err) {
        console.error('POST /checklist/nota:', err.message);
        res.status(500).json({ success: false, error: 'Error al guardar nota' });
    }
});

// ── CRUD Categorías ───────────────────────────────────────────────────────────
router.post('/categorias', async (req, res) => {
    const { nombre, color, orden } = req.body;
    if (!nombre) return res.status(400).json({ success: false, error: 'Falta nombre' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO checklist_categorias (nombre, color, orden) VALUES ($1, $2, $3) RETURNING *`,
            [nombre, color || '#f59e0b', orden ?? 99]
        );
        res.json({ success: true, categoria: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

router.patch('/categorias/:id', async (req, res) => {
    const { nombre, color, orden, activa } = req.body;
    try {
        await pool.query(
            `UPDATE checklist_categorias
             SET nombre = COALESCE($1, nombre),
                 color  = COALESCE($2, color),
                 orden  = COALESCE($3, orden),
                 activa = COALESCE($4, activa)
             WHERE id = $5`,
            [nombre ?? null, color ?? null, orden ?? null, activa ?? null, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── CRUD Actividades ──────────────────────────────────────────────────────────
router.post('/actividades', async (req, res) => {
    const { categoria_id, titulo, descripcion, prioridad, obligatoria, orden, impacto_esperado } = req.body;
    if (!categoria_id || !titulo) return res.status(400).json({ success: false, error: 'Faltan campos' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO checklist_actividades (categoria_id, titulo, descripcion, prioridad, obligatoria, orden, impacto_esperado)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [categoria_id, titulo, descripcion ?? null, prioridad ?? 'normal', obligatoria ?? false, orden ?? 99, impacto_esperado ?? null]
        );
        res.json({ success: true, actividad: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

router.patch('/actividades/:id', async (req, res) => {
    const { titulo, descripcion, prioridad, obligatoria, orden, impacto_esperado, activa, categoria_id } = req.body;
    try {
        await pool.query(
            `UPDATE checklist_actividades
             SET titulo           = COALESCE($1, titulo),
                 descripcion      = COALESCE($2, descripcion),
                 prioridad        = COALESCE($3, prioridad),
                 obligatoria      = COALESCE($4, obligatoria),
                 orden            = COALESCE($5, orden),
                 impacto_esperado = COALESCE($6, impacto_esperado),
                 activa           = COALESCE($7, activa),
                 categoria_id     = COALESCE($8, categoria_id)
             WHERE id = $9`,
            [titulo ?? null, descripcion ?? null, prioridad ?? null, obligatoria ?? null, orden ?? null, impacto_esperado ?? null, activa ?? null, categoria_id ?? null, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── GET /checklist/historial?tipo=standup&limit=7 ─────────────────────────────
router.get('/historial', async (req, res) => {
    const tipo = req.query.tipo || 'standup';
    const limit = Math.min(Number(req.query.limit) || 7, 30);
    try {
        const { rows } = await pool.query(
            `SELECT fecha::text, contenido, enviado_en, creado_en
             FROM checklist_notas_dia
             WHERE tipo = $1
             ORDER BY fecha DESC
             LIMIT $2`,
            [tipo, limit]
        );
        res.json({ success: true, notas: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
