const express = require('express');
const pool = require('../db');
const { enviarCorreoNotificacionVoto } = require('../services/emailService');
const { generarImagenBono } = require('../services/bonoService');
const { obtenerSaldoUsuario } = require('../services/walletService');
const { CUPO_VALOR } = require('../config/planes');
const { getOrSet, invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');
const { generarICS } = require('../services/calendarioService');
const { votarLimiter } = require('../middleware/rateLimiters');
const usuarioAuth = require('../middleware/usuarioAuth');

const router = express.Router();

const COSTO_CUPO_FASE = {
    grupos: 1, dieciseisavos: 1, octavos: 1,
    cuartos: 2, semifinal: 2, final: 4,
};

function puntajeExacto(fase) {
    return ({ grupos: 100, dieciseisavos: 120, octavos: 200, cuartos: 250, semifinal: 800, final: 2000 })[fase] ?? 100;
}
function puntajeTendencia(fase) {
    return ({ grupos: 50, dieciseisavos: 60, octavos: 100, cuartos: 125, semifinal: 400, final: 1000 })[fase] ?? 50;
}

// GET /api/polla/bono/:token - imagen del bono digital (PNG), pública para poder enviarla por WhatsApp
router.get('/bono/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT t.saldo_bono, t.es_test, u.nombre
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.token_acceso = $1 AND t.estado_pago = 'APROBADO'
             LIMIT 1`,
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).send('Bono no encontrado');
        }

        const { nombre, saldo_bono, es_test } = rows[0];

        // El bono no cambia una vez aprobada la transacción: se cachea para evitar
        // regenerar la imagen (operación costosa con sharp) en cada visualización.
        const bonoBuffer = await getOrSet(`bono:${token}`, 24 * 60 * 60 * 1000, () =>
            generarImagenBono({ nombre, saldoBono: saldo_bono, tokenAcceso: token, esTest: es_test })
        );

        res.set('Content-Type', 'image/png');
        return res.send(bonoBuffer);
    } catch (err) {
        console.error('Error en /polla/bono/:token:', err);
        return res.status(500).send('Error interno');
    }
});

// GET /api/polla/datos-registro/:token - datos de la compra aprobada para
// pre-llenar y bloquear correo/celular en el formulario de registro (Flujo
// "primero compra, luego registro"). Así el registro queda atado a la misma
// cuenta de la compra, sin que el comprador pueda teclear datos distintos.
router.get('/datos-registro/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT u.nombre, u.correo, u.celular, (u.password_hash IS NOT NULL) AS ya_registrado
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.token_acceso = $1 AND t.estado_pago = 'APROBADO'
             LIMIT 1`,
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).json({ encontrado: false });
        }

        const { nombre, correo, celular, ya_registrado } = rows[0];
        return res.json({ encontrado: true, nombre, correo, celular, ya_registrado });
    } catch (err) {
        console.error('Error en /polla/datos-registro/:token:', err);
        return res.status(500).json({ encontrado: false, error: 'Error interno' });
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
                    p.fase,
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
            fase: p.fase,
            cupos_costo: COSTO_CUPO_FASE[p.fase] ?? 1,
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

// GET /api/polla/bonos-vendidos - contador público de bonos vendidos (compras
// aprobadas reales, sin contar cuentas de prueba), para mostrar cupos
// restantes frente al tope real de 3000 bonos. Cacheado 60s.
router.get('/bonos-vendidos', async (req, res) => {
    try {
        const total = await getOrSet('bonos-vendidos', 60 * 1000, async () => {
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int AS total FROM transacciones WHERE estado_pago = 'APROBADO' AND es_test = FALSE`
            );
            return rows[0].total;
        });
        return res.json({ success: true, total });
    } catch (err) {
        console.error('Error en /polla/bonos-vendidos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
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
router.post('/votar', votarLimiter, async (req, res) => {
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

        if (partido.estado !== 'activo' || msRestantes < 5 * 60 * 1000) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'La votación cierra 5 minutos antes del pitazo' });
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

        // Costo en cupos según la fase del partido
        const costoPartido = COSTO_CUPO_FASE[partido.fase] ?? 1;

        // Validar que el usuario tenga cupos suficientes para esta fase
        const cuposTotales = transaccionRows.reduce(
            (acc, t) => acc + Math.floor(t.valor_pagado / CUPO_VALOR),
            0
        );
        const { rows: usadosRows } = await client.query(
            'SELECT COALESCE(SUM(cupos_costo), 0)::int AS cupos_usados FROM pronosticos WHERE usuario_id = $1',
            [usuario_id]
        );
        const cuposUsados = usadosRows[0].cupos_usados;
        const cuposDisponibles = Math.max(cuposTotales - cuposUsados, 0);

        if (cuposDisponibles < costoPartido) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: `No tienes cupos suficientes. Este partido requiere ${costoPartido} cupo(s).` });
        }

        // Insertar el pronóstico registrando el costo en cupos de esta fase
        await client.query(
            `INSERT INTO pronosticos (transaccion_id, usuario_id, partido_id, goles_local, goles_visitante, cupos_costo)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [transaccionRows[0].id, usuario_id, partido_id, local, visitante, costoPartido]
        );

        await client.query('COMMIT');

        invalidate(`ranking:${partido_id}`);
        invalidate(`resumen:${partido_id}`);
        invalidate(`pronosticos:${partido_id}`);
        notificar(partido_id);

        const dineroRecargado = transaccionRows.reduce((acc, t) => acc + t.valor_pagado, 0);
        const nuevosCuposUsados = cuposUsados + costoPartido;
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

// POST /api/polla/registrar-compartida
// Registra que el usuario compartió su pronóstico de un partido (máx 1 vez por partido).
// Si es la primera vez, otorga 1 punto bonus al usuario.
router.post('/registrar-compartida', async (req, res) => {
    const { token_acceso, partido_id } = req.body;
    if (!token_acceso || !partido_id) {
        return res.status(400).json({ success: false, error: 'Faltan campos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: tokenRows } = await client.query(
            `SELECT usuario_id FROM transacciones WHERE token_acceso = $1 AND estado_pago = 'APROBADO' LIMIT 1`,
            [token_acceso]
        );
        if (tokenRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Token inválido' });
        }
        const { usuario_id } = tokenRows[0];

        const { rowCount } = await client.query(
            `INSERT INTO compartidas (usuario_id, partido_id)
             VALUES ($1, CAST($2 AS integer))
             ON CONFLICT (usuario_id, partido_id) DO NOTHING`,
            [usuario_id, partido_id]
        );

        let puntos_ganados = 0;
        if (rowCount > 0) {
            await client.query(
                'UPDATE usuarios SET puntos_bonus = LEAST(puntos_bonus + 10, 200) WHERE id = $1',
                [usuario_id]
            );
            puntos_ganados = 10;
        }

        await client.query('COMMIT');
        return res.json({ success: true, puntos_ganados });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en registrar-compartida:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

// GET /api/polla/resumen-usuario - estadísticas personales del usuario autenticado
// (antes aceptaba ?usuario_id= libremente: cualquiera podía ver los datos y el
// token_polla de cualquier otro usuario adivinando su id. Ahora el id se resuelve
// del token de sesión, nunca del que mande el cliente.)
router.get('/resumen-usuario', usuarioAuth, async (req, res) => {
    const usuario_id = req.usuario.id;

    try {
        // Intentos pagados (cupos de transacciones)
        const saldo = await obtenerSaldoUsuario(usuario_id);

        // Total de pronósticos realizados (incluyendo flash)
        const { rows: totalRows } = await pool.query(
            'SELECT COUNT(*)::int AS total FROM pronosticos WHERE usuario_id = $1',
            [usuario_id]
        );
        const intentos_realizados = totalRows[0].total;

        // Puntos: exactos y parciales con escala por fase del partido
        const { rows: puntosRows } = await pool.query(
            `SELECT
                COUNT(*) FILTER (
                    WHERE p.estado = 'cerrado'
                    AND pr.goles_local = p.goles_local
                    AND pr.goles_visitante = p.goles_visitante
                )::int AS exactos,
                COUNT(*) FILTER (
                    WHERE p.estado = 'cerrado'
                    AND (
                        (pr.goles_local > pr.goles_visitante AND p.goles_local > p.goles_visitante) OR
                        (pr.goles_local < pr.goles_visitante AND p.goles_local < p.goles_visitante) OR
                        (pr.goles_local = pr.goles_visitante AND p.goles_local = p.goles_visitante)
                    )
                    AND NOT (pr.goles_local = p.goles_local AND pr.goles_visitante = p.goles_visitante)
                )::int AS parciales,
                COALESCE(SUM(
                    CASE
                        WHEN p.estado = 'cerrado'
                             AND pr.goles_local = p.goles_local
                             AND pr.goles_visitante = p.goles_visitante
                        THEN CASE p.fase
                            WHEN 'grupos'        THEN 100
                            WHEN 'dieciseisavos' THEN 120
                            WHEN 'octavos'       THEN 200
                            WHEN 'cuartos'       THEN 250
                            WHEN 'semifinal'     THEN 800
                            WHEN 'final'         THEN 2000
                            ELSE 100
                        END
                        WHEN p.estado = 'cerrado'
                             AND (
                                 (pr.goles_local > pr.goles_visitante AND p.goles_local > p.goles_visitante) OR
                                 (pr.goles_local < pr.goles_visitante AND p.goles_local < p.goles_visitante) OR
                                 (pr.goles_local = pr.goles_visitante AND p.goles_local = p.goles_visitante)
                             )
                             AND NOT (pr.goles_local = p.goles_local AND pr.goles_visitante = p.goles_visitante)
                        THEN CASE p.fase
                            WHEN 'grupos'        THEN 50
                            WHEN 'dieciseisavos' THEN 60
                            WHEN 'octavos'       THEN 100
                            WHEN 'cuartos'       THEN 125
                            WHEN 'semifinal'     THEN 400
                            WHEN 'final'         THEN 1000
                            ELSE 50
                        END
                        ELSE 0
                    END
                ), 0)::int AS puntos_pronosticos
             FROM pronosticos pr
             JOIN partidos p ON p.id = pr.partido_id
             WHERE pr.usuario_id = $1`,
            [usuario_id]
        );
        const exactos = puntosRows[0].exactos;
        const parciales = puntosRows[0].parciales;
        const puntos_pronosticos = puntosRows[0].puntos_pronosticos;

        // Puntos bonus (compartidas + referidos)
        const { rows: bonusRows } = await pool.query(
            'SELECT puntos_bonus FROM usuarios WHERE id = $1',
            [usuario_id]
        );
        const puntos_bonus = bonusRows[0]?.puntos_bonus || 0;
        const puntos = puntos_pronosticos + puntos_bonus;

        // Posición en el ranking global — $1 = puntos totales (pronósticos + bonus) del usuario actual
        const { rows: posRows } = await pool.query(
            `SELECT COUNT(*)::int + 1 AS posicion
             FROM (
                 SELECT pts FROM (
                     SELECT pr2.usuario_id,
                         COALESCE(SUM(
                             CASE
                                 WHEN p2.estado = 'cerrado'
                                      AND pr2.goles_local = p2.goles_local
                                      AND pr2.goles_visitante = p2.goles_visitante
                                 THEN CASE p2.fase
                                     WHEN 'grupos' THEN 100 WHEN 'dieciseisavos' THEN 120 WHEN 'octavos' THEN 200
                                     WHEN 'cuartos' THEN 250 WHEN 'semifinal' THEN 800 WHEN 'final' THEN 2000 ELSE 100
                                 END
                                 WHEN p2.estado = 'cerrado'
                                      AND (
                                          (pr2.goles_local > pr2.goles_visitante AND p2.goles_local > p2.goles_visitante) OR
                                          (pr2.goles_local < pr2.goles_visitante AND p2.goles_local < p2.goles_visitante) OR
                                          (pr2.goles_local = pr2.goles_visitante AND p2.goles_local = p2.goles_visitante)
                                      )
                                      AND NOT (pr2.goles_local = p2.goles_local AND pr2.goles_visitante = p2.goles_visitante)
                                 THEN CASE p2.fase
                                     WHEN 'grupos' THEN 50 WHEN 'dieciseisavos' THEN 60 WHEN 'octavos' THEN 100
                                     WHEN 'cuartos' THEN 125 WHEN 'semifinal' THEN 400 WHEN 'final' THEN 1000 ELSE 50
                                 END
                                 ELSE 0
                             END
                         ), 0) + COALESCE(u2.puntos_bonus, 0) AS pts
                     FROM pronosticos pr2
                     JOIN partidos p2 ON p2.id = pr2.partido_id
                     JOIN usuarios u2 ON u2.id = pr2.usuario_id
                     GROUP BY pr2.usuario_id, u2.puntos_bonus
                 ) inner_pts
                 WHERE pts > CAST($1 AS integer)
             ) liders`,
            [puntos]
        );

        // Total de participantes con al menos 1 pronóstico
        const { rows: totalPart } = await pool.query(
            'SELECT COUNT(DISTINCT usuario_id)::int AS total FROM pronosticos'
        );

        // Puntos mínimos del usuario inmediatamente arriba en el ranking (incluye bonus)
        const { rows: sigRows } = await pool.query(
            `SELECT MIN(pts) AS puntos_siguiente
             FROM (
                 SELECT pts FROM (
                     SELECT pr2.usuario_id,
                         COALESCE(SUM(
                             CASE
                                 WHEN p2.estado = 'cerrado'
                                      AND pr2.goles_local = p2.goles_local
                                      AND pr2.goles_visitante = p2.goles_visitante
                                 THEN CASE p2.fase
                                     WHEN 'grupos' THEN 100 WHEN 'dieciseisavos' THEN 120 WHEN 'octavos' THEN 200
                                     WHEN 'cuartos' THEN 250 WHEN 'semifinal' THEN 800 WHEN 'final' THEN 2000 ELSE 100
                                 END
                                 WHEN p2.estado = 'cerrado'
                                      AND (
                                          (pr2.goles_local > pr2.goles_visitante AND p2.goles_local > p2.goles_visitante) OR
                                          (pr2.goles_local < pr2.goles_visitante AND p2.goles_local < p2.goles_visitante) OR
                                          (pr2.goles_local = pr2.goles_visitante AND p2.goles_local = p2.goles_visitante)
                                      )
                                      AND NOT (pr2.goles_local = p2.goles_local AND pr2.goles_visitante = p2.goles_visitante)
                                 THEN CASE p2.fase
                                     WHEN 'grupos' THEN 50 WHEN 'dieciseisavos' THEN 60 WHEN 'octavos' THEN 100
                                     WHEN 'cuartos' THEN 125 WHEN 'semifinal' THEN 400 WHEN 'final' THEN 1000 ELSE 50
                                 END
                                 ELSE 0
                             END
                         ), 0) + COALESCE(u2.puntos_bonus, 0) AS pts
                     FROM pronosticos pr2
                     JOIN partidos p2 ON p2.id = pr2.partido_id
                     JOIN usuarios u2 ON u2.id = pr2.usuario_id
                     WHERE pr2.usuario_id != CAST($1 AS integer)
                     GROUP BY pr2.usuario_id, u2.puntos_bonus
                 ) inner_pts
                 WHERE pts > CAST($2 AS integer)
             ) ranking`,
            [usuario_id, puntos]
        );
        const puntos_siguiente = sigRows[0]?.puntos_siguiente != null ? parseInt(sigRows[0].puntos_siguiente) : null;
        const puntos_para_superar = puntos_siguiente != null ? puntos_siguiente - puntos : null;

        // Token del bono más reciente (para enlazar directo a la página de pronosticar)
        const { rows: tokenRows } = await pool.query(
            `SELECT token_acceso FROM transacciones
             WHERE usuario_id = $1 AND estado_pago = 'APROBADO'
             ORDER BY id DESC LIMIT 1`,
            [usuario_id]
        );
        const token_polla = tokenRows[0]?.token_acceso || null;

        return res.json({
            success: true,
            intentos_realizados,
            intentos_pagados: saldo.cuposTotales,
            intentos_disponibles: saldo.cuposDisponibles,
            puntos,
            exactos,
            parciales,
            posicion: posRows[0].posicion,
            total_participantes: totalPart[0].total,
            puntos_para_superar,
            token_polla,
        });
    } catch (err) {
        console.error('Error en /polla/resumen-usuario:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/polla/mis-pronosticos - historial de pronósticos del usuario autenticado
router.get('/mis-pronosticos', usuarioAuth, async (req, res) => {
    const usuario_id = req.usuario.id;

    try {
        const { rows } = await pool.query(
            `SELECT
                pr.id,
                pr.goles_local        AS pred_local,
                pr.goles_visitante    AS pred_visitante,
                pr.created_at,
                pr.es_flash,
                p.id                  AS partido_id,
                p.equipo_local,
                p.equipo_visitante,
                p.goles_local         AS res_local,
                p.goles_visitante     AS res_visitante,
                p.estado,
                p.fase,
                p.fecha_hora_inicio,
                CASE
                    WHEN p.estado = 'cerrado'
                         AND pr.goles_local = p.goles_local
                         AND pr.goles_visitante = p.goles_visitante
                        THEN CASE p.fase
                            WHEN 'grupos'        THEN 100
                            WHEN 'dieciseisavos' THEN 120
                            WHEN 'octavos'       THEN 200
                            WHEN 'cuartos'       THEN 250
                            WHEN 'semifinal'     THEN 800
                            WHEN 'final'         THEN 2000
                            ELSE 100
                        END
                    WHEN p.estado = 'cerrado'
                         AND (
                             (pr.goles_local > pr.goles_visitante AND p.goles_local > p.goles_visitante) OR
                             (pr.goles_local < pr.goles_visitante AND p.goles_local < p.goles_visitante) OR
                             (pr.goles_local = pr.goles_visitante AND p.goles_local = p.goles_visitante)
                         )
                         AND NOT (pr.goles_local = p.goles_local AND pr.goles_visitante = p.goles_visitante)
                        THEN CASE p.fase
                            WHEN 'grupos'        THEN 50
                            WHEN 'dieciseisavos' THEN 60
                            WHEN 'octavos'       THEN 100
                            WHEN 'cuartos'       THEN 125
                            WHEN 'semifinal'     THEN 400
                            WHEN 'final'         THEN 1000
                            ELSE 50
                        END
                    WHEN p.estado = 'cerrado' THEN 0
                    ELSE NULL
                END AS puntos_partido
             FROM pronosticos pr
             JOIN partidos p ON p.id = pr.partido_id
             WHERE pr.usuario_id = $1
             ORDER BY p.fecha_hora_inicio DESC`,
            [usuario_id]
        );

        return res.json({ success: true, pronosticos: rows });
    } catch (err) {
        console.error('Error en /polla/mis-pronosticos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/polla/pozo - pozo de premios actual (público)
router.get('/pozo', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT primero, segundo, tercero, total_fact, actualizado FROM pozo_premios WHERE id = 1'
        );
        if (rows.length === 0) {
            return res.json({ success: true, primero: 2000000, segundo: 1000000, tercero: 500000, total_fact: 0 });
        }
        return res.json({ success: true, ...rows[0] });
    } catch (err) {
        console.error('Error en /polla/pozo:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── PROMOCIÓN RELÁMPAGO ──────────────────────────────────────────────────────
// Partidos donde cualquier usuario registrado puede pronosticar sin bono,
// con ventana de 60 minutos DESPUÉS del pitazo inicial.
// Válido únicamente para las fechas y equipos indicados.
const FLASH_PARTIDOS = [
    { equipoLocal: 'Argentina', equipoVisitante: 'Argelia',  fecha: '2026-06-16', ventanaMin: 60 },
    { equipoLocal: 'Austria',   equipoVisitante: 'Jordania', fecha: '2026-06-16', ventanaMin: 60 },
];

function buscarConfigFlash(partido) {
    const fechaPartido = new Date(partido.fecha_hora_inicio).toISOString().substring(0, 10);
    return FLASH_PARTIDOS.find(f =>
        f.equipoLocal === partido.equipo_local &&
        f.equipoVisitante === partido.equipo_visitante &&
        f.fecha === fechaPartido
    ) || null;
}

// GET /api/polla/flash - lista los partidos de la promoción relámpago activos hoy
router.get('/flash', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, equipo_local, equipo_visitante, fecha_hora_inicio, estado
             FROM partidos
             WHERE estado = 'activo'
             ORDER BY fecha_hora_inicio ASC`
        );
        const flash = rows
            .filter(p => buscarConfigFlash(p))
            .map(p => {
                const conf = buscarConfigFlash(p);
                const inicio = new Date(p.fecha_hora_inicio);
                const cierre = new Date(inicio.getTime() + conf.ventanaMin * 60 * 1000);
                return { ...p, cierre_flash: cierre.toISOString(), ventana_minutos: conf.ventanaMin };
            });
        return res.json({ success: true, partidos: flash });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/polla/votar-flash - pronóstico gratuito en promoción relámpago.
// Recibe el celular (no el usuario_id) y resuelve el usuario en el servidor:
// el usuario_id es un entero secuencial adivinable, así que aceptarlo directo
// del cliente permitiría votar a nombre de cualquier otra persona (y "quemar"
// su único intento en la promoción antes de que ella misma pueda participar).
router.post('/votar-flash', votarLimiter, async (req, res) => {
    const { celular, partido_id, local, visitante } = req.body;
    const celularNormalizado = String(celular || '').replace(/[^0-9+]/g, '').trim();

    if (
        !celularNormalizado || !partido_id ||
        typeof local !== 'number' || typeof visitante !== 'number' ||
        local < 0 || visitante < 0 ||
        !Number.isInteger(local) || !Number.isInteger(visitante)
    ) {
        return res.status(400).json({ success: false, error: 'Datos inválidos' });
    }

    try {
        const { rows: usuarioRows } = await pool.query(
            `SELECT id, nombre, correo FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
            [celularNormalizado]
        );
        if (usuarioRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }
        const usuario_id = usuarioRows[0].id;

        const { rows: partidoRows } = await pool.query(
            'SELECT * FROM partidos WHERE id = $1',
            [partido_id]
        );
        if (partidoRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }

        const partido = partidoRows[0];
        const conf = buscarConfigFlash(partido);

        if (!conf) {
            return res.status(403).json({ success: false, error: 'Este partido no hace parte de la promoción relámpago' });
        }

        if (partido.estado !== 'activo') {
            return res.status(403).json({ success: false, error: 'La votación para este partido ya está cerrada' });
        }

        const ahoraUTC = new Date();
        const inicioPartido = new Date(partido.fecha_hora_inicio);
        const msDesdeInicio = ahoraUTC.getTime() - inicioPartido.getTime();
        const ventanaMs = conf.ventanaMin * 60 * 1000;

        if (msDesdeInicio > ventanaMs) {
            return res.status(403).json({ success: false, error: 'La ventana de la promoción relámpago ya cerró para este partido' });
        }

        const { rows: existeRows } = await pool.query(
            'SELECT id FROM pronosticos WHERE usuario_id = $1 AND partido_id = $2',
            [usuario_id, partido_id]
        );
        if (existeRows.length > 0) {
            return res.status(400).json({ success: false, error: 'Ya registraste tu pronóstico para este partido' });
        }

        await pool.query(
            `INSERT INTO pronosticos (transaccion_id, usuario_id, partido_id, goles_local, goles_visitante, es_flash)
             VALUES (NULL, $1, $2, $3, $4, TRUE)`,
            [usuario_id, partido_id, local, visitante]
        );

        invalidate(`ranking:${partido_id}`);
        invalidate(`resumen:${partido_id}`);
        invalidate(`pronosticos:${partido_id}`);
        notificar(partido_id);

        return res.json({ success: true });
    } catch (err) {
        console.error('Error en votar-flash:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/polla/resultados-finales - top 3 del ranking con premios (público)
router.get('/resultados-finales', async (req, res) => {
    try {
        const { rows: top3 } = await pool.query(`
            SELECT u.id, u.nombre,
                   COALESCE(SUM(
                       CASE
                           WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante
                                AND pa.goles_local IS NOT NULL
                           THEN CASE pa.fase
                               WHEN 'grupos'        THEN 100
                               WHEN 'dieciseisavos' THEN 120
                               WHEN 'octavos'       THEN 200
                               WHEN 'cuartos'       THEN 250
                               WHEN 'semifinal'     THEN 800
                               WHEN 'final'         THEN 2000
                               ELSE 100 END
                           WHEN pr.goles_local IS NOT NULL AND pa.goles_local IS NOT NULL
                                AND SIGN(pr.goles_local - pr.goles_visitante) = SIGN(pa.goles_local - pa.goles_visitante)
                                AND NOT (pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante)
                           THEN CASE pa.fase
                               WHEN 'grupos'        THEN 50
                               WHEN 'dieciseisavos' THEN 60
                               WHEN 'octavos'       THEN 100
                               WHEN 'cuartos'       THEN 125
                               WHEN 'semifinal'     THEN 400
                               WHEN 'final'         THEN 1000
                               ELSE 50 END
                           ELSE 0
                       END
                   ), 0) + COALESCE(u.puntos_bonus, 0) AS puntos_total,
                   COUNT(
                       CASE WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante
                                 AND pa.goles_local IS NOT NULL THEN 1 END
                   ) AS exactos
            FROM usuarios u
            LEFT JOIN pronosticos pr ON pr.usuario_id = u.id
            LEFT JOIN partidos pa ON pa.id = pr.partido_id AND pa.estado = 'cerrado'
            WHERE u.es_test = FALSE
            GROUP BY u.id, u.nombre, u.puntos_bonus
            ORDER BY puntos_total DESC, exactos DESC
            LIMIT 3
        `);

        const { rows: pozoRows } = await pool.query(
            'SELECT primero, segundo, tercero FROM pozo_premios WHERE id = 1'
        );
        const { rows: countRows } = await pool.query(
            'SELECT COUNT(*)::int AS total FROM usuarios WHERE es_test = FALSE'
        );

        const premios = pozoRows[0] || { primero: 2000000, segundo: 1000000, tercero: 500000 };

        return res.json({
            success: true,
            top3: top3.map((u, i) => ({
                posicion: i + 1,
                nombre: u.nombre,
                puntos: Number(u.puntos_total),
                exactos: Number(u.exactos),
            })),
            premios,
            total_participantes: countRows[0]?.total || 0,
        });
    } catch (err) {
        console.error('Error en /polla/resultados-finales:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
