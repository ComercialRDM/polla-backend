const express = require('express');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { aprobarTransaccion, rechazarTransaccion } = require('../services/aprobacionService');

const router = express.Router();

router.use(adminAuth);

// GET /api/admin/pendientes
router.get('/pendientes', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT t.id, u.nombre, u.correo, u.celular, t.valor_pagado, t.metodo, t.estado_pago, t.fecha_creacion,
                    (t.comprobante_imagen IS NOT NULL) AS tiene_comprobante
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             ORDER BY t.fecha_creacion DESC`
        );

        const transacciones = rows.map((t) => ({
            id: t.id,
            nombre: t.nombre,
            correo: t.correo,
            celular: t.celular,
            valorPagado: t.valor_pagado,
            metodo: t.metodo,
            estado: t.estado_pago,
            fecha: new Date(t.fecha_creacion).getTime(),
            tieneComprobante: t.tiene_comprobante,
        }));

        return res.json({ success: true, transacciones });
    } catch (err) {
        console.error('Error en /admin/pendientes:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/comprobante/:id - devuelve la imagen del comprobante de pago
router.get('/comprobante/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await pool.query(
            'SELECT comprobante_imagen, comprobante_mime FROM transacciones WHERE id = $1',
            [id]
        );

        if (rows.length === 0 || !rows[0].comprobante_imagen) {
            return res.status(404).json({ success: false, error: 'Comprobante no encontrado' });
        }

        res.set('Content-Type', rows[0].comprobante_mime || 'image/jpeg');
        return res.send(rows[0].comprobante_imagen);
    } catch (err) {
        console.error('Error en /admin/comprobante:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/partidos
router.post('/partidos', async (req, res) => {
    const { equipo_local, equipo_visitante, fecha_hora_inicio } = req.body;

    if (!equipo_local || !equipo_visitante || !fecha_hora_inicio) {
        return res.status(400).json({ success: false, error: 'Faltan campos: equipo_local, equipo_visitante, fecha_hora_inicio' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO partidos (equipo_local, equipo_visitante, fecha_hora_inicio)
             VALUES ($1, $2, $3)
             RETURNING id, equipo_local, equipo_visitante, fecha_hora_inicio, estado`,
            [equipo_local, equipo_visitante, fecha_hora_inicio]
        );
        return res.json({ success: true, partido: rows[0] });
    } catch (err) {
        console.error('Error en /admin/partidos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// DELETE /api/admin/partidos/:id
router.delete('/partidos/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await pool.query('DELETE FROM partidos WHERE id = $1 RETURNING id', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        return res.json({ success: true });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({ success: false, error: 'No se puede eliminar: el partido tiene transacciones o pronósticos asociados' });
        }
        console.error('Error en /admin/partidos delete:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/aprobar
router.post('/aprobar', async (req, res) => {
    const { transaccion_id } = req.body;
    if (!transaccion_id) {
        return res.status(400).json({ success: false, error: 'Falta transaccion_id' });
    }

    try {
        const resultado = await aprobarTransaccion({ transaccionId: transaccion_id, pasarelaTransaccionId: 'MANUAL-ADMIN' });
        if (!resultado.ok) {
            return res.status(409).json({ success: false, error: 'La transacción no está pendiente' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /admin/aprobar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/rechazar
router.post('/rechazar', async (req, res) => {
    const { transaccion_id } = req.body;
    if (!transaccion_id) {
        return res.status(400).json({ success: false, error: 'Falta transaccion_id' });
    }

    try {
        const resultado = await rechazarTransaccion({ transaccionId: transaccion_id });
        if (!resultado.ok) {
            return res.status(409).json({ success: false, error: 'La transacción no está pendiente' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /admin/rechazar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
