const express = require('express');
const pool = require('../db');
const { enviarCorreoNotificacionVoto } = require('../services/emailService');
const { generarImagenBono } = require('../services/bonoService');

const router = express.Router();

// GET /api/polla/bono/:token - imagen del bono digital (PNG), pública para poder enviarla por WhatsApp
router.get('/bono/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT t.saldo_bono, u.nombre
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.token_acceso = $1 AND t.estado_pago = 'APROBADO'
             LIMIT 1`,
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).send('Bono no encontrado');
        }

        const { nombre, saldo_bono } = rows[0];
        const bonoBuffer = await generarImagenBono({ nombre, saldoBono: saldo_bono });

        res.set('Content-Type', 'image/png');
        return res.send(bonoBuffer);
    } catch (err) {
        console.error('Error en /polla/bono/:token:', err);
        return res.status(500).send('Error interno');
    }
});

// GET /api/polla/info?token_acceso=
// Recupera los datos de la transacción y del partido a partir del token (link de acceso por correo)
router.get('/info', async (req, res) => {
    const { token_acceso } = req.query;

    if (!token_acceso) {
        return res.status(400).json({ acceso: false, error: 'Falta token_acceso' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT t.*, u.nombre, u.equipos_favoritos, p.equipo_local, p.equipo_visitante, p.fecha_hora_inicio, p.estado AS estado_partido
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             JOIN partidos p ON p.id = t.partido_id
             WHERE t.token_acceso = $1 AND t.estado_pago = 'APROBADO'
             LIMIT 1`,
            [token_acceso]
        );

        if (rows.length === 0) {
            return res.json({ acceso: false });
        }

        const t = rows[0];
        return res.json({
            acceso: true,
            nombre: t.nombre,
            partido_id: t.partido_id,
            equipo_local: t.equipo_local,
            equipo_visitante: t.equipo_visitante,
            fecha_hora_inicio: t.fecha_hora_inicio,
            estado_partido: t.estado_partido,
            intentos_disponibles: t.intentos_totales - t.intentos_usados,
            intentos_totales: t.intentos_totales,
            equipos_favoritos: t.equipos_favoritos || [],
        });
    } catch (err) {
        console.error('Error en /polla/info:', err);
        return res.status(500).json({ acceso: false, error: 'Error interno' });
    }
});

// GET /api/polla/verificar-acceso?contacto=
router.get('/verificar-acceso', async (req, res) => {
    const { contacto } = req.query;

    if (!contacto) {
        return res.status(400).json({ acceso: false, error: 'Faltan parámetros' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT t.*, u.nombre, u.correo
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE (u.correo = $1 OR u.celular = $1)
               AND t.estado_pago = 'APROBADO'
             ORDER BY t.id DESC
             LIMIT 1`,
            [contacto]
        );

        if (rows.length === 0) {
            return res.json({ acceso: false });
        }

        const transaccion = rows[0];
        const intentosDisponibles = transaccion.intentos_totales - transaccion.intentos_usados;

        return res.json({
            acceso: true,
            token_acceso: transaccion.token_acceso,
            nombre: transaccion.nombre,
            correo: transaccion.correo,
            intentos_disponibles: intentosDisponibles,
        });
    } catch (err) {
        console.error('Error en verificar-acceso:', err);
        return res.status(500).json({ acceso: false, error: 'Error interno' });
    }
});

// PUT /api/polla/equipos-favoritos - guarda los equipos favoritos del usuario (personalización opcional)
router.put('/equipos-favoritos', async (req, res) => {
    const { token_acceso, equipos_favoritos } = req.body;

    if (!token_acceso || !Array.isArray(equipos_favoritos)) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    if (equipos_favoritos.length > 5 || equipos_favoritos.some((e) => typeof e !== 'string' || !e.trim())) {
        return res.status(400).json({ success: false, error: 'Selecciona como máximo 5 equipos válidos' });
    }

    try {
        const { rows } = await pool.query(
            `UPDATE usuarios u
             SET equipos_favoritos = $1
             FROM transacciones t
             WHERE t.usuario_id = u.id AND t.token_acceso = $2 AND t.estado_pago = 'APROBADO'
             RETURNING u.equipos_favoritos`,
            [equipos_favoritos, token_acceso]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Acceso no válido' });
        }

        return res.json({ success: true, equipos_favoritos: rows[0].equipos_favoritos });
    } catch (err) {
        console.error('Error en /polla/equipos-favoritos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/polla/votar
router.post('/votar', async (req, res) => {
    const { token_acceso, partido_id, marcadores } = req.body;

    if (!token_acceso || !partido_id || !Array.isArray(marcadores) || marcadores.length === 0) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    for (const m of marcadores) {
        if (
            typeof m.local !== 'number' || typeof m.visitante !== 'number' ||
            m.local < 0 || m.visitante < 0 ||
            !Number.isInteger(m.local) || !Number.isInteger(m.visitante)
        ) {
            return res.status(400).json({ success: false, error: 'Marcadores inválidos' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Bloquear la fila de la transacción para evitar condiciones de carrera
        const { rows: transaccionRows } = await client.query(
            `SELECT * FROM transacciones WHERE token_acceso = $1 AND partido_id = $2 AND estado_pago = 'APROBADO' FOR UPDATE`,
            [token_acceso, partido_id]
        );

        if (transaccionRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Acceso no válido' });
        }

        const transaccion = transaccionRows[0];

        // Verificar el partido y la hora límite (hora del servidor UTC como única verdad)
        const { rows: partidoRows } = await client.query('SELECT * FROM partidos WHERE id = $1 FOR UPDATE', [partido_id]);
        if (partidoRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const partido = partidoRows[0];

        const ahoraUTC = new Date();
        const inicioPartido = new Date(partido.fecha_hora_inicio);
        const msRestantes = inicioPartido.getTime() - ahoraUTC.getTime();

        if (partido.estado !== 'activo' || msRestantes < 1000) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'La votación para este partido ya está cerrada' });
        }

        // Validar que los marcadores no superen los intentos disponibles
        const intentosDisponibles = transaccion.intentos_totales - transaccion.intentos_usados;
        if (marcadores.length > intentosDisponibles) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'No tienes suficientes intentos disponibles' });
        }

        // Insertar pronósticos
        for (const m of marcadores) {
            await client.query(
                `INSERT INTO pronosticos (transaccion_id, usuario_id, partido_id, goles_local, goles_visitante)
                 VALUES ($1, $2, $3, $4, $5)`,
                [transaccion.id, transaccion.usuario_id, partido_id, m.local, m.visitante]
            );
        }

        // Sumar intentos usados
        await client.query(
            'UPDATE transacciones SET intentos_usados = intentos_usados + $1 WHERE id = $2',
            [marcadores.length, transaccion.id]
        );

        await client.query('COMMIT');

        try {
            const { rows: usuarioRows } = await pool.query(
                'SELECT nombre, correo FROM usuarios WHERE id = $1',
                [transaccion.usuario_id]
            );
            const usuario = usuarioRows[0];
            await enviarCorreoNotificacionVoto({
                nombre: usuario.nombre,
                correo: usuario.correo,
                equipoLocal: partido.equipo_local,
                equipoVisitante: partido.equipo_visitante,
                marcadores,
                fecha: new Date(),
            });
        } catch (errCorreo) {
            console.error('Error al enviar correo de notificación de voto:', errCorreo);
        }

        return res.json({
            success: true,
            pronosticos_registrados: marcadores.length,
            intentos_disponibles: intentosDisponibles - marcadores.length,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en votar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
