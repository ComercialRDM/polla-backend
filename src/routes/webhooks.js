const express = require('express');
const pool = require('../db');
const { validarFirmaWebhook } = require('../services/wompiService');
const { aprobarTransaccion, rechazarTransaccion } = require('../services/aprobacionService');

const router = express.Router();

// POST /api/webhooks/wompi
router.post('/wompi', async (req, res) => {
    const evento = req.body;

    try {
        if (!evento || !evento.data || !evento.data.transaction) {
            return res.status(200).send('ignorado');
        }

        // 1. Validar firma del evento
        if (!validarFirmaWebhook(evento)) {
            return res.status(401).json({ success: false, error: 'Firma inválida' });
        }

        const transaccionWompi = evento.data.transaction;
        const { status, amount_in_cents, id: pasarelaTransaccionId, payment_link_id, reference } = transaccionWompi;

        // 2. Emparejar transacción por payment_link_id (reference de respaldo)
        let { rows } = await pool.query(
            'SELECT * FROM transacciones WHERE payment_link_id = $1',
            [payment_link_id]
        );

        if (rows.length === 0 && reference) {
            const resultado = await pool.query('SELECT * FROM transacciones WHERE reference = $1', [reference]);
            rows = resultado.rows;
        }

        if (rows.length === 0) {
            console.warn('Webhook Wompi: transacción no encontrada', { payment_link_id, reference });
            return res.status(200).send('transaccion no encontrada');
        }

        const transaccion = rows[0];

        if (status === 'APPROVED') {
            // Verificación anti-fraude: el monto recibido debe coincidir con lo esperado
            const montoEsperadoCentavos = transaccion.valor_pagado * 100;
            if (Number(amount_in_cents) !== montoEsperadoCentavos) {
                console.error('Webhook Wompi: monto no coincide', {
                    esperado: montoEsperadoCentavos,
                    recibido: amount_in_cents,
                    transaccionId: transaccion.id,
                });
                return res.status(200).send('monto no coincide');
            }

            await aprobarTransaccion({ transaccionId: transaccion.id, pasarelaTransaccionId });
        } else if (['DECLINED', 'VOIDED', 'ERROR'].includes(status)) {
            await rechazarTransaccion({ transaccionId: transaccion.id });
        }

        return res.status(200).send('ok');
    } catch (err) {
        console.error('Error procesando webhook de Wompi:', err);
        return res.status(200).send('error interno, evento recibido');
    }
});

module.exports = router;
