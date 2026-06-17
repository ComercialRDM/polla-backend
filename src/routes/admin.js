const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { generarToken } = require('../utils/adminTokens');
const { aprobarTransaccion, rechazarTransaccion } = require('../services/aprobacionService');
const { enviarCorreoRecompra, enviarCorreoBonoColWinner } = require('../services/emailService');
const { crearTransaccionesPrueba, limpiarTransaccionesPrueba } = require('../services/testService');
const { invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');
const { enviarMensajeManyChat, formatearCelularWhatsApp } = require('../services/manychatService');

const router = express.Router();

// POST /api/admin/login - autenticación con cuenta individual (usuario + contraseña)
router.post('/login', async (req, res) => {
    const { usuario, password } = req.body;

    if (!usuario || !password) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT id, usuario, password_hash FROM admin_usuarios WHERE usuario = $1 AND activo = TRUE',
            [usuario]
        );

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
        }

        const valido = await bcrypt.compare(password, rows[0].password_hash);
        if (!valido) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
        }

        const token = generarToken({ id: rows[0].id, usuario: rows[0].usuario });
        return res.json({ success: true, token, usuario: rows[0].usuario });
    } catch (err) {
        console.error('Error en /admin/login:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

router.use(adminAuth);

// GET /api/admin/pendientes
router.get('/pendientes', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT t.id, u.nombre, u.correo, u.celular, t.valor_pagado, t.metodo, t.estado_pago, t.fecha_creacion,
                    (t.comprobante_imagen IS NOT NULL) AS tiene_comprobante
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.es_test = FALSE
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
    const { equipo_local, equipo_visitante, fecha_hora_inicio, fase = 'grupos' } = req.body;
    const FASES_VALIDAS = ['grupos', 'dieciseisavos', 'octavos', 'cuartos', 'semifinal', 'final'];

    if (!equipo_local || !equipo_visitante || !fecha_hora_inicio) {
        return res.status(400).json({ success: false, error: 'Faltan campos: equipo_local, equipo_visitante, fecha_hora_inicio' });
    }
    if (!FASES_VALIDAS.includes(fase)) {
        return res.status(400).json({ success: false, error: 'Fase inválida' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO partidos (equipo_local, equipo_visitante, fecha_hora_inicio, fase)
             VALUES ($1, $2, $3, $4)
             RETURNING id, equipo_local, equipo_visitante, fecha_hora_inicio, estado, fase`,
            [equipo_local, equipo_visitante, fecha_hora_inicio, fase]
        );
        invalidate('partidos:lista');
        return res.json({ success: true, partido: rows[0] });
    } catch (err) {
        console.error('Error en /admin/partidos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/partidos/:id - corrige fecha, marcador o estado de un partido
router.patch('/partidos/:id', async (req, res) => {
    const { id } = req.params;
    const { fecha_hora_inicio, goles_local, goles_visitante, estado, fase } = req.body;

    if (estado && !['activo', 'cerrado'].includes(estado)) {
        return res.status(400).json({ success: false, error: 'Estado inválido' });
    }

    const campos = [];
    const valores = [];
    let i = 1;

    if (fecha_hora_inicio !== undefined) { campos.push(`fecha_hora_inicio = $${i++}`); valores.push(fecha_hora_inicio); }
    if (goles_local !== undefined) { campos.push(`goles_local = $${i++}`); valores.push(goles_local); }
    if (goles_visitante !== undefined) { campos.push(`goles_visitante = $${i++}`); valores.push(goles_visitante); }
    if (estado !== undefined) { campos.push(`estado = $${i++}`); valores.push(estado); }
    if (fase !== undefined) { campos.push(`fase = $${i++}`); valores.push(fase); }

    if (campos.length === 0) {
        return res.status(400).json({ success: false, error: 'No hay campos para actualizar' });
    }

    valores.push(id);

    try {
        const { rows } = await pool.query(
            `UPDATE partidos SET ${campos.join(', ')} WHERE id = $${i} RETURNING id, equipo_local, equipo_visitante, fecha_hora_inicio, goles_local, goles_visitante, estado, fase`,
            valores
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const partido = rows[0];
        invalidate('partidos:lista');
        invalidate(`ranking:${id}`);
        invalidate(`resumen:${id}`);
        notificar(id);

        // Bono Colombia $500K: se activa al cerrar un partido de Colombia en fase grupos con marcador
        let bonoColombia = null;
        if (
            partido.estado === 'cerrado' &&
            partido.fase === 'grupos' &&
            partido.goles_local !== null &&
            partido.goles_visitante !== null &&
            (partido.equipo_local.toLowerCase() === 'colombia' || partido.equipo_visitante.toLowerCase() === 'colombia')
        ) {
            const { rows: exactos } = await pool.query(
                `SELECT pr.usuario_id, u.nombre, u.correo, u.celular
                 FROM pronosticos pr
                 JOIN usuarios u ON u.id = pr.usuario_id
                 WHERE pr.partido_id = $1
                   AND pr.goles_local = $2
                   AND pr.goles_visitante = $3`,
                [id, partido.goles_local, partido.goles_visitante]
            );
            if (exactos.length > 0) {
                const montoPorGanador = Math.floor(500000 / exactos.length);
                const nombrePartido = `${partido.equipo_local} ${partido.goles_local} - ${partido.goles_visitante} ${partido.equipo_visitante}`;
                for (const g of exactos) {
                    await pool.query(
                        `INSERT INTO bonos_colombia (partido_id, usuario_id, monto_cop)
                         VALUES ($1, $2, $3) ON CONFLICT (partido_id, usuario_id) DO NOTHING`,
                        [id, g.usuario_id, montoPorGanador]
                    );
                    if (g.correo) {
                        enviarCorreoBonoColWinner({
                            destinatario: g.correo,
                            nombre: g.nombre,
                            partido: nombrePartido,
                            monto: montoPorGanador,
                        }).catch((err) => console.error('Error enviando email Bono Colombia:', err.message));
                    }
                }
                bonoColombia = {
                    ganadores: exactos.map((g) => ({ nombre: g.nombre, celular: g.celular })),
                    montoPorGanador,
                    totalDistribuido: montoPorGanador * exactos.length,
                };
            } else {
                bonoColombia = { ganadores: [], desierto: true };
            }
        }

        return res.json({ success: true, partido, bonoColombia });
    } catch (err) {
        console.error('Error en /admin/partidos PATCH:', err);
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
        invalidate('partidos:lista');
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

// POST /api/admin/notificar-recompra
// Envía un correo a todos los usuarios con bono APROBADO en partido_id_origen,
// invitándolos a comprar su bono para el siguiente partido (partido_id_destino).
router.post('/notificar-recompra', async (req, res) => {
    const { partido_id_origen, partido_id_destino } = req.body;

    if (!partido_id_origen || !partido_id_destino) {
        return res.status(400).json({ success: false, error: 'Faltan campos: partido_id_origen, partido_id_destino' });
    }

    try {
        const { rows: destinoRows } = await pool.query(
            'SELECT equipo_local, equipo_visitante FROM partidos WHERE id = $1',
            [partido_id_destino]
        );
        if (destinoRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido destino no encontrado' });
        }
        const { equipo_local, equipo_visitante } = destinoRows[0];

        const { rows: usuarios } = await pool.query(
            `SELECT DISTINCT u.nombre, u.correo
             FROM usuarios u
             JOIN transacciones t ON t.usuario_id = u.id
             WHERE t.partido_id = $1 AND t.estado_pago = 'APROBADO'`,
            [partido_id_origen]
        );

        const linkCompra = `${process.env.FRONTEND_URL}/comprar`;
        let enviados = 0;
        for (const usuario of usuarios) {
            try {
                await enviarCorreoRecompra({
                    destinatario: usuario.correo,
                    nombre: usuario.nombre,
                    equipoLocal: equipo_local,
                    equipoVisitante: equipo_visitante,
                    linkCompra,
                });
                enviados += 1;
            } catch (err) {
                console.error(`Error enviando correo de recompra a ${usuario.correo}:`, err.message);
            }
        }

        return res.json({ success: true, enviados, total: usuarios.length });
    } catch (err) {
        console.error('Error en /admin/notificar-recompra:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/test/crear-prueba
// Crea cuentas + transacciones de PRUEBA (saldo virtual, es_test = TRUE) para un
// grupo de amigos, con 1 cupo de pronóstico cada uno para el partido indicado, y
// les envía el bono por correo/WhatsApp marcado como "PRUEBA". No genera cobros
// reales ni aparece en rankings/reportes públicos.
// Body: { amigos: [{ nombre, celular, correo? }], equipoA, equipoB }
router.post('/test/crear-prueba', async (req, res) => {
    const { amigos, equipoA, equipoB } = req.body;

    if (!Array.isArray(amigos) || amigos.length === 0 || !equipoA || !equipoB) {
        return res.status(400).json({ success: false, error: 'Faltan campos: amigos (array), equipoA, equipoB' });
    }

    try {
        const resultado = await crearTransaccionesPrueba({ amigos, equipoA, equipoB });
        return res.json({ success: true, ...resultado });
    } catch (err) {
        console.error('Error en /admin/test/crear-prueba:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/admin/test/limpiar
// Elimina todas las transacciones y pronósticos de prueba (es_test = TRUE).
router.delete('/test/limpiar', async (req, res) => {
    try {
        const resultado = await limpiarTransaccionesPrueba();
        return res.json({ success: true, ...resultado });
    } catch (err) {
        console.error('Error en /admin/test/limpiar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/apuestas - pronósticos paginados de un partido (100 filas/página)
// ?partido_id=X&page=1&limit=100&search=
router.get('/apuestas', async (req, res) => {
    const { partido_id, page = 1, limit = 100, search = '' } = req.query;

    if (!partido_id) {
        return res.status(400).json({ success: false, error: 'Falta partido_id' });
    }

    const limitNum = Math.min(Number(limit) || 100, 500);
    const offset   = (Math.max(Number(page), 1) - 1) * limitNum;
    const like     = search ? `%${search}%` : '%';

    try {
        const { rows: pRows } = await pool.query(
            `SELECT id, equipo_local, equipo_visitante, goles_local, goles_visitante, estado
             FROM partidos WHERE id = CAST($1 AS integer) LIMIT 1`,
            [partido_id]
        );
        if (pRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const partido = pRows[0];

        const [{ rows: countRows }, { rows: apRows }, { rows: resumenRows }] = await Promise.all([
            pool.query(
                `SELECT COUNT(*)::int AS total
                 FROM pronosticos pr JOIN usuarios u ON u.id = pr.usuario_id
                 WHERE pr.partido_id = CAST($1 AS integer)
                   AND (u.nombre ILIKE $2 OR u.celular ILIKE $2)`,
                [partido_id, like]
            ),
            pool.query(
                `SELECT pr.id, u.nombre, u.celular,
                        pr.goles_local AS pred_local, pr.goles_visitante AS pred_visitante,
                        pr.created_at
                 FROM pronosticos pr JOIN usuarios u ON u.id = pr.usuario_id
                 WHERE pr.partido_id = CAST($1 AS integer)
                   AND (u.nombre ILIKE $2 OR u.celular ILIKE $2)
                 ORDER BY pr.created_at DESC NULLS LAST, pr.id DESC
                 LIMIT $3 OFFSET $4`,
                [partido_id, like, limitNum, offset]
            ),
            pool.query(
                `SELECT goles_local AS pred_local, goles_visitante AS pred_visitante, COUNT(*)::int AS cantidad
                 FROM pronosticos WHERE partido_id = CAST($1 AS integer)
                 GROUP BY goles_local, goles_visitante
                 ORDER BY cantidad DESC LIMIT 20`,
                [partido_id]
            ),
        ]);

        return res.json({
            success: true,
            partido,
            total: countRows[0].total,
            page: Number(page),
            limit: limitNum,
            apuestas: apRows.map(r => ({
                id:          r.id,
                nombre:      r.nombre,
                celular:     r.celular,
                predLocal:   r.pred_local,
                predVisitante: r.pred_visitante,
                createdAt:   r.created_at,
                puntos:      calcPuntos(partido, r.pred_local, r.pred_visitante),
            })),
            resumen: resumenRows.map(r => ({
                predLocal: r.pred_local,
                predVisitante: r.pred_visitante,
                cantidad: r.cantidad,
            })),
        });
    } catch (err) {
        console.error('Error en /admin/apuestas:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/apuestas/export - TODAS las filas sin paginación (para CSV/Excel/PDF)
router.get('/apuestas/export', async (req, res) => {
    const { partido_id } = req.query;
    if (!partido_id) {
        return res.status(400).json({ success: false, error: 'Falta partido_id' });
    }

    try {
        const { rows: pRows } = await pool.query(
            `SELECT id, equipo_local, equipo_visitante, goles_local, goles_visitante, estado
             FROM partidos WHERE id = CAST($1 AS integer) LIMIT 1`,
            [partido_id]
        );
        if (pRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const partido = pRows[0];

        const { rows } = await pool.query(
            `SELECT u.nombre, u.celular,
                    pr.goles_local AS pred_local, pr.goles_visitante AS pred_visitante,
                    pr.created_at
             FROM pronosticos pr JOIN usuarios u ON u.id = pr.usuario_id
             WHERE pr.partido_id = CAST($1 AS integer)
             ORDER BY pr.created_at DESC NULLS LAST, pr.id DESC`,
            [partido_id]
        );

        return res.json({
            success: true,
            partido,
            apuestas: rows.map(r => ({
                nombre:      r.nombre,
                celular:     r.celular,
                predLocal:   r.pred_local,
                predVisitante: r.pred_visitante,
                createdAt:   r.created_at,
                puntos:      calcPuntos(partido, r.pred_local, r.pred_visitante),
            })),
        });
    } catch (err) {
        console.error('Error en /admin/apuestas/export:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

function calcPuntos(partido, predLocal, predVisitante) {
    if (partido.estado !== 'cerrado') return null;
    const rl = partido.goles_local;
    const rv = partido.goles_visitante;
    if (rl === null || rv === null) return null;
    if (predLocal === rl && predVisitante === rv) return 3;
    if ((rl > rv && predLocal > predVisitante) ||
        (rl < rv && predLocal < predVisitante) ||
        (rl === rv && predLocal === predVisitante)) return 1;
    return 0;
}

// GET /api/admin/codigo-reset/:celular - muestra el código OTP activo para recuperar contraseña
router.get('/codigo-reset/:celular', async (req, res) => {
    const celular = String(req.params.celular || '').replace(/[^0-9+]/g, '');
    if (!celular) return res.status(400).json({ success: false, error: 'Celular inválido' });

    try {
        const { rows } = await pool.query(
            `SELECT nombre, celular, reset_code, reset_code_expira
             FROM usuarios
             WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
            [celular]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });

        const u = rows[0];
        const expirado = !u.reset_code_expira || new Date(u.reset_code_expira) < new Date();
        return res.json({
            success: true,
            nombre: u.nombre,
            celular: u.celular,
            codigo: u.reset_code || null,
            expira: u.reset_code_expira,
            vigente: !!u.reset_code && !expirado,
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/test-whatsapp - diagnóstico paso a paso: createSubscriber → sendContent
router.post('/test-whatsapp', async (req, res) => {
    const { celular } = req.body;
    if (!celular) return res.status(400).json({ success: false, error: 'Falta celular' });

    const apiKey = process.env.MANYCHAT_API_KEY;
    if (!apiKey) {
        return res.json({ success: false, error: 'MANYCHAT_API_KEY no está configurada en las variables de entorno de Render.' });
    }

    const axios = require('axios');
    const BASE = process.env.MANYCHAT_API_URL || 'https://api.manychat.com';
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const celularFormateado = `+${formatearCelularWhatsApp(celular)}`;

    // Paso 1: createSubscriber
    let paso1;
    try {
        const { data } = await axios.post(`${BASE}/fb/subscriber/createSubscriber`,
            { whatsapp_phone: celularFormateado, consent_phrase: 'Acepto recibir mensajes de La Retoucherie' },
            { headers, validateStatus: () => true }
        );
        paso1 = data;
    } catch (err) {
        return res.json({ success: false, paso: 'createSubscriber', error: err.message, celularFormateado });
    }

    let subscriberId = paso1?.data?.id;

    // Paso 1b: si createSubscriber falló (suscriptor ya existe), buscarlo por WhatsApp phone
    let paso1b = null;
    if (!subscriberId && paso1?.status === 'error') {
        const waId = formatearCelularWhatsApp(celular); // sin '+'
        try {
            const { data } = await axios.get(
                `${BASE}/fb/subscriber/findBySystemField?system_field=whatsapp_phone&value=${waId}`,
                { headers, validateStatus: () => true }
            );
            paso1b = data;
            subscriberId = data?.data?.id || null;
        } catch (err) {
            paso1b = { error: err.message };
        }
    }

    if (!subscriberId) {
        return res.json({
            success: false,
            paso: 'createSubscriber + findBySystemField — subscriber ID no encontrado',
            celularFormateado,
            error: `ManyChat no devolvió subscriber_id en ninguno de los dos intentos.`,
            detalles: paso1,
            detalles_busqueda: paso1b,
        });
    }

    // Paso 2: sendContent
    let paso2;
    try {
        const { data } = await axios.post(`${BASE}/fb/sending/sendContent`, {
            subscriber_id: subscriberId,
            data: { version: 'v2', content: { type: 'whatsapp', messages: [{ type: 'text', text: '🧪 Prueba — Polla Mundialista La Retoucherie. Si recibes esto, WhatsApp funciona.' }] } },
        }, { headers, validateStatus: () => true });
        paso2 = data;
    } catch (err) {
        return res.json({ success: false, paso: 'sendContent', subscriberId, celularFormateado, error: err.message, detalles: paso1 });
    }

    return res.json({
        success: paso2?.status === 'success',
        paso: 'sendContent',
        subscriberId,
        celularFormateado,
        detalles: paso2,
        ...(paso2?.status !== 'success' && { error: `sendContent falló: ${JSON.stringify(paso2)}` }),
    });
});

// GET /api/admin/bonos-colombia - historial de ganadores del Bono Colombia
router.get('/bonos-colombia', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT bc.id, bc.monto_cop, bc.reclamado, bc.created_at,
                   u.nombre, u.correo, u.celular,
                   p.equipo_local, p.equipo_visitante,
                   p.goles_local, p.goles_visitante, p.fecha_hora_inicio
            FROM bonos_colombia bc
            JOIN usuarios u ON u.id = bc.usuario_id
            JOIN partidos p ON p.id = bc.partido_id
            ORDER BY bc.created_at DESC
        `);
        return res.json({ success: true, bonos: rows });
    } catch (err) {
        console.error('Error en GET /admin/bonos-colombia:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/bonos-colombia/:id - marcar como reclamado
router.patch('/bonos-colombia/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(
            'UPDATE bonos_colombia SET reclamado = TRUE WHERE id = $1 RETURNING id',
            [id]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'No encontrado' });
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en PATCH /admin/bonos-colombia:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
