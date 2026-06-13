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
            `SELECT t.id, u.nombre, u.correo, u.celular, t.valor_pagado, t.metodo, t.estado_pago, t.fecha_creacion
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
        }));

        return res.json({ success: true, transacciones });
    } catch (err) {
        console.error('Error en /admin/pendientes:', err);
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
