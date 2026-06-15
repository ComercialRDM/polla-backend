const express = require('express');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');
const {
    META_INGRESOS,
    FECHA_META,
    PRECIO_REFERENCIA,
    TASA_CONVERSION_REFERENCIA,
    ELASTICIDAD,
    PRECIO_SIMULADOR_MIN,
    PRECIO_SIMULADOR_MAX,
    PRECIO_SIMULADOR_PASO,
    diasRestantesHasta,
} = require('../config/elasticidad');

const router = express.Router();

// Todas las rutas de este archivo son exclusivas del panel admin (RBAC: role ADMIN)
router.use(adminAuth);

const CLICS_DIARIOS_POR_DEFECTO = 50; // valor de respaldo si todavía no hay datos de ManyChat

// GET /api/admin/simulador/metricas
// Datos en vivo para alimentar el simulador de ingresos: ingresos actuales,
// promedio de clics diarios de ManyChat, registros diarios de usuarios y
// funnel de checkout (tasa de rebote/abandono).
router.get('/metricas', async (req, res) => {
    try {
        const { rows: ingresosRows } = await pool.query(
            `SELECT COALESCE(SUM(valor_pagado), 0)::bigint AS ingresos_actuales
             FROM transacciones WHERE estado_pago = 'APROBADO'`
        );

        const { rows: manychatRows } = await pool.query(
            `SELECT fecha, mensajes_enviados, aperturas, clics
             FROM manychat_metricas_diarias
             ORDER BY fecha DESC LIMIT 7`
        );

        const { rows: registrosRows } = await pool.query(
            `SELECT date(fecha_registro) AS fecha, COUNT(*)::int AS total
             FROM usuarios
             WHERE fecha_registro >= now() - interval '14 days'
             GROUP BY date(fecha_registro)
             ORDER BY fecha DESC`
        );

        const { rows: checkoutRows } = await pool.query(
            `SELECT estado_pago, COUNT(*)::int AS total
             FROM transacciones
             WHERE fecha_creacion >= now() - interval '30 days'
             GROUP BY estado_pago`
        );

        const checkout = { PENDIENTE: 0, APROBADO: 0, RECHAZADO: 0 };
        let totalCheckout = 0;
        for (const fila of checkoutRows) {
            checkout[fila.estado_pago] = fila.total;
            totalCheckout += fila.total;
        }
        const tasaRebote = totalCheckout > 0
            ? (checkout.PENDIENTE + checkout.RECHAZADO) / totalCheckout
            : 0;

        const clicsRecientes = manychatRows.map((f) => f.clics);
        const clicsDiariosPromedio = clicsRecientes.length > 0
            ? clicsRecientes.reduce((acc, c) => acc + c, 0) / clicsRecientes.length
            : CLICS_DIARIOS_POR_DEFECTO;

        return res.json({
            success: true,
            ingresosActuales: Number(ingresosRows[0].ingresos_actuales),
            metaIngresos: META_INGRESOS,
            fechaMeta: FECHA_META,
            diasRestantes: diasRestantesHasta(),
            clicsDiariosPromedio,
            manychat: manychatRows,
            registrosDiarios: registrosRows,
            checkout: { ...checkout, total: totalCheckout, tasaRebote },
            modelo: {
                precioReferencia: PRECIO_REFERENCIA,
                tasaConversionReferencia: TASA_CONVERSION_REFERENCIA,
                elasticidad: ELASTICIDAD,
                precioMin: PRECIO_SIMULADOR_MIN,
                precioMax: PRECIO_SIMULADOR_MAX,
                precioPaso: PRECIO_SIMULADOR_PASO,
            },
        });
    } catch (err) {
        console.error('Error en GET /admin/simulador/metricas:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
