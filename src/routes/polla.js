const express = require('express');
const pool = require('../db');
const { enviarCorreoNotificacionVoto } = require('../services/emailService');
const { generarImagenBono } = require('../services/bonoService');
const { obtenerSaldoUsuario } = require('../services/walletService');
const { CUPO_VALOR } = require('../config/planes');
const { getOrSet, invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');
const { generarICS } = require('../services/calendarioService');

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

        // El bono no cambia una vez aprobada la transacción: se cachea para evitar
        // regenerar la imagen (operación costosa con sharp) en cada visualización.
        const bonoBuffer = await getOrSet(`bono:${token}`, 24 * 60 * 60 * 1000, () =>
            generarImagenBono({ nombre, saldoBono: saldo_bono, tokenAcceso: token })
        );

        res.set('Content-Type', 'image/png');
        return res.send(bonoBuffer);
    } catch (err) {
        console.error('Error en /polla/bono/:token:', err);
        return res.status(500).send('Error interno');
    }
});

// GET /api/polla/calendario/:calendario_token.ics - feed de calendario (.ics) con
// los partidos de los equipos favoritos del usuario, pública para poder suscribirse
// desde Apple/Google/Outlook Calendar.
router.get('/calendario/:calendario_token.ics', async (req, res) => {
    const { calendario_token } = req.params;

    try {
        const { rows: usuarioRows } = await pool.query(
            'SELECT equipos_favoritos FROM usuarios WHERE calendario_token = $1',
            [calendario_token]
        );

        const equiposFavoritos = usuarioRows[0]?.equipos_favoritos || [];

        let partidos = [];
        if (equiposFavoritos.length > 0) {
            const { rows } = await pool.query(
                `SELECT id, equipo_local, equipo_visitante, fecha_hora_inicio
                 FROM partidos
                 ORDER BY fecha_hora_inicio ASC`
            );
            partidos = rows;
        }

        const ics = generarICS({ equiposFavoritos, partidos });

        res.set('Content-Type', 'text/calendar; charset=utf-8');
        res.set('Cache-Control', 'no-cache');
        return res.send(ics);
    } catch (err) {
        console.error('Error en /polla/calendario/:calendario_token.ics:', err);
        return res.status(500).send('Error interno');
    }
});

// GET /api/polla/info?token_acceso=
// Recupera el monedero de cupos del usuario y la lista de partidos activos a partir del token
router.get('/info', async (req, res) => {
    const { token_acceso } = req.query;

    if (!token_acceso) {
        return res.status(400).json({ acceso: false, error: 'Falta token_acceso' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT t.usuario_id, u.nombre, u.equipos_favoritos, u.calendario_token
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.token_acceso = $1 AND t.estado_pago = 'APROBADO'
             LIMIT 1`,
            [token_acceso]
        );

        if (rows.length === 0) {
            return res.json({ acceso: false });
        }

        const { usuario_id, nombre, equipos_favoritos, calendario_token } = rows[0];

        const saldo = await obtenerSaldoUsuario(usuario_id);

        const { rows: partidoRows } = await pool.query(
            `SELECT p.id, p.equipo_local, p.equipo_visitante, p.fecha_hora_inicio, p.estado AS estado_partido,
                    pr.goles_local AS pronostico_local, pr.goles_visitante AS pronostico_visitante
             FROM partidos p
             LEFT JOIN pronosticos pr ON pr.partido_id = p.id AND pr.usuario_id = $1
             WHERE p.estado = 'activo'
             ORDER BY p.fecha_hora_inicio ASC`,
            [usuario_id]
        );

        const partidos = partidoRows.map((p) => ({
            partido_id: p.id,
            equipo_local: p.equipo_local,
            equipo_visitante: p.equipo_visitante,
            fecha_hora_inicio: p.fecha_hora_inicio,
            estado_partido: p.estado_partido,
            ya_pronosticado: p.pronostico_local !== null,
            pronostico: p.pronostico_local !== null
                ? { local: p.pronostico_local, visitante: p.pronostico_visitante }
                : null,
        }));

        return res.json({
            acceso: true,
            nombre,
            equipos_favoritos: equipos_favoritos || [],
            calendario_token,
            cupos_totales: saldo.cuposTotales,
            cupos_usados: saldo.cuposUsados,
            cupos_disponibles: saldo.cuposDisponibles,
            dinero_recargado: saldo.dineroRecargado,
            dinero_disponible: saldo.dineroDisponible,
            cupo_valor: CUPO_VALOR,
            partidos,
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
// Registra el pronóstico (un marcador) de un usuario para un partido, consumiendo 1 cupo de su monedero.
router.post('/votar', async (req, res) => {
    const { token_acceso, partido_id, local, visitante } = req.body;

    if (
        !token_acceso || !partido_id ||
        typeof local !== 'number' || typeof visitante !== 'number' ||
        local < 0 || visitante < 0 ||
        !Number.isInteger(local) || !Number.isInteger(visitante)
    ) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos o marcador inválido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Resolver el usuario a partir del token
        const { rows: tokenRows } = await client.query(
            `SELECT usuario_id FROM transacciones WHERE token_acceso = $1 AND estado_pago = 'APROBADO' LIMIT 1`,
            [token_acceso]
        );

        if (tokenRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Acceso no válido' });
        }

        const { usuario_id } = tokenRows[0];

        // Bloquear las transacciones aprobadas del usuario para serializar el cálculo del monedero
        const { rows: transaccionRows } = await client.query(
            `SELECT id, valor_pagado FROM transacciones WHERE usuario_id = $1 AND estado_pago = 'APROBADO' FOR UPDATE`,
            [usuario_id]
        );

        if (transaccionRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Acceso no válido' });
        }

        // Verificar el partido y la hora límite (hora del servidor UTC como única verdad)
        const { rows: partidoRows } = await client.query('SELECT * FROM partidos WHERE id = $1', [partido_id]);
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

        // No permitir más de un pronóstico por partido
        const { rows: existeRows } = await client.query(
            'SELECT id FROM pronosticos WHERE usuario_id = $1 AND partido_id = $2',
            [usuario_id, partido_id]
        );
        if (existeRows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Ya registraste tu pronóstico para este partido' });
        }

        // Validar que el usuario tenga al menos 1 cupo disponible
        const cuposTotales = transaccionRows.reduce(
            (acc, t) => acc + Math.floor(t.valor_pagado / CUPO_VALOR),
            0
        );
        const { rows: usadosRows } = await client.query(
            'SELECT COUNT(*)::int AS cupos_usados FROM pronosticos WHERE usuario_id = $1',
            [usuario_id]
        );
        const cuposUsados = usadosRows[0].cupos_usados;
        const cuposDisponibles = Math.max(cuposTotales - cuposUsados, 0);

        if (cuposDisponibles < 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'No tienes cupos disponibles. Recarga para seguir pronosticando.' });
        }

        // Insertar el pronóstico (se asocia a una de las transacciones aprobadas del usuario para mantener la FK)
        await client.query(
            `INSERT INTO pronosticos (transaccion_id, usuario_id, partido_id, goles_local, goles_visitante)
             VALUES ($1, $2, $3, $4, $5)`,
            [transaccionRows[0].id, usuario_id, partido_id, local, visitante]
        );

        await client.query('COMMIT');

        invalidate(`ranking:${partido_id}`);
        invalidate(`resumen:${partido_id}`);
        invalidate(`pronosticos:${partido_id}`);
        notificar(partido_id);

        const dineroRecargado = transaccionRows.reduce((acc, t) => acc + t.valor_pagado, 0);
        const nuevosCuposUsados = cuposUsados + 1;
        const nuevosCuposDisponibles = Math.max(cuposTotales - nuevosCuposUsados, 0);
        const nuevoDineroDisponible = Math.max(dineroRecargado - nuevosCuposUsados * CUPO_VALOR, 0);

        try {
            const { rows: usuarioRows } = await pool.query(
                'SELECT nombre, correo FROM usuarios WHERE id = $1',
                [usuario_id]
            );
            const usuario = usuarioRows[0];
            await enviarCorreoNotificacionVoto({
                nombre: usuario.nombre,
                correo: usuario.correo,
                equipoLocal: partido.equipo_local,
                equipoVisitante: partido.equipo_visitante,
                local,
                visitante,
                fecha: new Date(),
            });
        } catch (errCorreo) {
            console.error('Error al enviar correo de notificación de voto:', errCorreo);
        }

        return res.json({
            success: true,
            cupos_disponibles: nuevosCuposDisponibles,
            dinero_disponible: nuevoDineroDisponible,
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
