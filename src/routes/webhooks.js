const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { validarFirmaWebhook } = require('../services/wompiService');
const { aprobarTransaccion, rechazarTransaccion } = require('../services/aprobacionService');
const { calcularRanking } = require('../services/rankingService');
const { notificarGanadoresDelGol } = require('../services/notificacionesService');
const { registrarEvento } = require('../services/auditoriaService');
const { obtenerIp } = require('../utils/request');

const router = express.Router();

const FUTBOL_WEBHOOK_SECRET = process.env.FUTBOL_WEBHOOK_SECRET;
const MANYCHAT_METRICAS_SECRET = process.env.MANYCHAT_METRICAS_SECRET;

if (!FUTBOL_WEBHOOK_SECRET) {
    console.warn('FUTBOL_WEBHOOK_SECRET no está configurado: /api/webhooks/partido-en-vivo queda sin protección por secreto.');
}
if (!MANYCHAT_METRICAS_SECRET) {
    console.warn('MANYCHAT_METRICAS_SECRET no está configurado: /api/webhooks/manychat-metricas queda sin protección por secreto.');
}

// Comparación de igualdad en tiempo constante para strings de distinta longitud
function compararSeguro(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

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

        // Firma ya validada arriba: se guarda el payload crudo completo de Wompi
        // como evidencia forense, independiente de los campos derivados que se
        // usan para aprobar/rechazar (esos pueden cambiar de formato; este no).
        await registrarEvento({
            tabla: 'transacciones',
            registroId: transaccion.id,
            accion: 'webhook_wompi_recibido',
            despues: evento,
            ip: obtenerIp(req),
        });

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

// POST /api/webhooks/partido-en-vivo
// Recibe los eventos en tiempo real de una API deportiva (ej. API-Football) con el formato:
// { fixture: { id, status }, teams: { home: { name }, away: { name } }, goals: { home, away } }
router.post('/partido-en-vivo', async (req, res) => {
    if (!FUTBOL_WEBHOOK_SECRET) {
        return res.status(503).json({ success: false, error: 'Webhook no configurado' });
    }
    const secretRecibido = req.headers['x-webhook-secret'];
    if (!compararSeguro(secretRecibido, FUTBOL_WEBHOOK_SECRET)) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    try {
        const { teams, goals } = req.body || {};

        if (!teams?.home?.name || !teams?.away?.name || typeof goals?.home !== 'number' || typeof goals?.away !== 'number') {
            return res.status(200).json({ success: false, error: 'Payload incompleto, ignorado' });
        }

        const golesLocalNuevo = goals.home;
        const golesVisitanteNuevo = goals.away;

        // Ubicar el partido activo correspondiente por nombre de los equipos
        const { rows: partidoRows } = await pool.query(
            `SELECT id, goles_local, goles_visitante FROM partidos
             WHERE estado = 'activo' AND equipo_local ILIKE $1 AND equipo_visitante ILIKE $2
             LIMIT 1`,
            [teams.home.name, teams.away.name]
        );

        if (partidoRows.length === 0) {
            return res.status(200).json({ success: false, error: 'Partido activo no encontrado' });
        }

        const partido = partidoRows[0];
        const golesLocalAnterior = partido.goles_local ?? 0;
        const golesVisitanteAnterior = partido.goles_visitante ?? 0;

        const marcadorCambio = golesLocalAnterior !== golesLocalNuevo || golesVisitanteAnterior !== golesVisitanteNuevo;

        if (!marcadorCambio) {
            return res.status(200).json({ success: true, cambio: false });
        }

        await pool.query(
            'UPDATE partidos SET goles_local = $1, goles_visitante = $2 WHERE id = $3',
            [golesLocalNuevo, golesVisitanteNuevo, partido.id]
        );

        // Ranking actualizado con la regla de desempate por fecha_registro ASC
        const ranking = await calcularRanking(partido.id);

        // Notificación de gol vía ManyChat para quienes ahora aciertan el marcador (no bloquea la respuesta)
        notificarGanadoresDelGol({ ganadores: ranking.ganadores, golesLocalNuevo, golesVisitanteNuevo })
            .catch((err) => console.error('Error notificando ganadores del gol:', err));

        return res.status(200).json({ success: true, cambio: true, ranking });
    } catch (err) {
        console.error('Error en webhook partido-en-vivo:', err);
        return res.status(200).json({ success: false, error: 'error interno, evento recibido' });
    }
});

// POST /api/webhooks/manychat-metricas
// Recibe métricas diarias de campañas de ManyChat (mensajes enviados, tasa
// de apertura, clics al link de la polla) para alimentar el simulador de
// ingresos del panel admin. Protegido por secreto compartido (no es un
// usuario ni un admin autenticado: es una llamada servidor-a-servidor de
// ManyChat), separado de las rutas /api/admin (protegidas por RBAC).
// Body: { fecha: "YYYY-MM-DD", mensajes_enviados, aperturas, clics }
router.post('/manychat-metricas', async (req, res) => {
    if (!MANYCHAT_METRICAS_SECRET) {
        return res.status(503).json({ success: false, error: 'Webhook no configurado' });
    }
    const secretRecibido = req.headers['x-webhook-secret'];
    if (!compararSeguro(secretRecibido, MANYCHAT_METRICAS_SECRET)) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const { fecha, mensajes_enviados, aperturas, clics } = req.body || {};

    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ success: false, error: 'Falta "fecha" en formato YYYY-MM-DD' });
    }

    try {
        await pool.query(
            `INSERT INTO manychat_metricas_diarias (fecha, mensajes_enviados, aperturas, clics, fecha_actualizacion)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (fecha) DO UPDATE SET
                mensajes_enviados = EXCLUDED.mensajes_enviados,
                aperturas = EXCLUDED.aperturas,
                clics = EXCLUDED.clics,
                fecha_actualizacion = now()`,
            [fecha, Number(mensajes_enviados) || 0, Number(aperturas) || 0, Number(clics) || 0]
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('Error en webhook manychat-metricas:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
