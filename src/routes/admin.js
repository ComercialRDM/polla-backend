const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { generarToken } = require('../utils/adminTokens');
const { aprobarTransaccion, rechazarTransaccion } = require('../services/aprobacionService');
const { enviarCorreoRecompra, enviarCorreoBonoColWinner } = require('../services/emailService');
const { crearTransaccionesPrueba, limpiarTransaccionesPrueba } = require('../services/testService');
const { invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');
const { enviarMensajeManyChat, formatearCelularWhatsApp, obtenerSubscriberId } = require('../services/manychatService');

const router = express.Router();

// POST /api/admin/login - autenticación con usuario + contraseña [+ TOTP si 2FA activo]
router.post('/login', async (req, res) => {
    const { usuario, password, totp_code } = req.body;

    if (!usuario || !password) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT id, usuario, password_hash, totp_secret, totp_enabled, token_version FROM admin_usuarios WHERE usuario = $1 AND activo = TRUE',
            [usuario]
        );

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
        }

        const valido = await bcrypt.compare(password, rows[0].password_hash);
        if (!valido) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
        }

        // Si 2FA está activo, exigir el código TOTP
        if (rows[0].totp_enabled) {
            if (!totp_code) {
                return res.status(200).json({ success: false, requires_2fa: true });
            }
            const valido2fa = speakeasy.totp.verify({ secret: rows[0].totp_secret, encoding: 'base32', token: totp_code, window: 1 });
            if (!valido2fa) {
                return res.status(401).json({ success: false, error: 'Código de verificación incorrecto' });
            }
        }

        const token = generarToken({ id: rows[0].id, usuario: rows[0].usuario, tv: rows[0].token_version });
        return res.json({ success: true, token, usuario: rows[0].usuario });
    } catch (err) {
        console.error('Error en /admin/login:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

router.use(adminAuth);

// POST /api/admin/2fa/setup - genera secret TOTP + QR (no activa aún)
router.post('/2fa/setup', async (req, res) => {
    const adminId = req.admin.id;
    try {
        const { rows } = await pool.query('SELECT usuario, totp_enabled FROM admin_usuarios WHERE id = $1', [adminId]);
        if (rows[0].totp_enabled) {
            return res.status(409).json({ success: false, error: '2FA ya está activo. Desactívalo primero.' });
        }
        const secretObj = speakeasy.generateSecret({ length: 20, name: `Admin:${rows[0].usuario}`, issuer: 'Polla La Retoucherie' });
        const qrDataUrl = await QRCode.toDataURL(secretObj.otpauth_url);
        // Guardar secret base32 pendiente (totp_enabled sigue en FALSE hasta confirmar)
        await pool.query('UPDATE admin_usuarios SET totp_secret = $1 WHERE id = $2', [secretObj.base32, adminId]);
        return res.json({ success: true, qrDataUrl });
    } catch (err) {
        console.error('Error en /admin/2fa/setup:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/2fa/confirmar - verifica primer código y activa 2FA
router.post('/2fa/confirmar', async (req, res) => {
    const { code } = req.body;
    const adminId = req.admin.id;
    if (!code) return res.status(400).json({ success: false, error: 'Falta code' });
    try {
        const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM admin_usuarios WHERE id = $1', [adminId]);
        if (!rows[0].totp_secret) return res.status(400).json({ success: false, error: 'Primero ejecuta /2fa/setup' });
        if (rows[0].totp_enabled) return res.status(409).json({ success: false, error: '2FA ya está activo' });
        if (!speakeasy.totp.verify({ secret: rows[0].totp_secret, encoding: 'base32', token: code, window: 1 })) {
            return res.status(401).json({ success: false, error: 'Código incorrecto. Verifica que la hora del dispositivo sea correcta.' });
        }
        await pool.query('UPDATE admin_usuarios SET totp_enabled = TRUE WHERE id = $1', [adminId]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /admin/2fa/confirmar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/2fa/desactivar - desactiva 2FA (requiere código válido como confirmación)
router.post('/2fa/desactivar', async (req, res) => {
    const { code } = req.body;
    const adminId = req.admin.id;
    if (!code) return res.status(400).json({ success: false, error: 'Falta code' });
    try {
        const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM admin_usuarios WHERE id = $1', [adminId]);
        if (!rows[0].totp_enabled) return res.status(400).json({ success: false, error: '2FA no está activo' });
        if (!speakeasy.totp.verify({ secret: rows[0].totp_secret, encoding: 'base32', token: code, window: 1 })) {
            return res.status(401).json({ success: false, error: 'Código incorrecto' });
        }
        // token_version + 1: si alguien con un token robado desactivó el 2FA para
        // debilitar la cuenta, esta misma acción invalida esa sesión y cualquier
        // otra abierta, forzando a iniciar sesión de nuevo con la contraseña.
        await pool.query('UPDATE admin_usuarios SET totp_secret = NULL, totp_enabled = FALSE, token_version = token_version + 1 WHERE id = $1', [adminId]);
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /admin/2fa/desactivar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/2fa/estado - indica si el admin actual tiene 2FA activo
router.get('/2fa/estado', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT totp_enabled FROM admin_usuarios WHERE id = $1', [req.admin.id]);
        return res.json({ success: true, totp_enabled: rows[0]?.totp_enabled ?? false });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/reportes?fecha_inicio=YYYY-MM-DD&fecha_fin=YYYY-MM-DD
router.get('/reportes', async (req, res) => {
    const { fecha_inicio, fecha_fin } = req.query;
    if (!fecha_inicio || !fecha_fin) {
        return res.status(400).json({ success: false, error: 'Faltan fecha_inicio y fecha_fin' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT t.id, u.nombre, u.correo, u.celular, t.valor_pagado, t.metodo, t.estado_pago, t.fecha_creacion, t.saldo_bono
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE date(t.fecha_creacion AT TIME ZONE 'America/Bogota') BETWEEN $1::date AND $2::date
               AND t.es_test = FALSE
             ORDER BY t.fecha_creacion DESC`,
            [fecha_inicio, fecha_fin]
        );

        const aprobadas = rows.filter(r => r.estado_pago === 'APROBADO');
        const ingresos  = aprobadas.reduce((acc, r) => acc + Number(r.valor_pagado), 0);

        return res.json({
            success: true,
            resumen: {
                total:      rows.length,
                aprobadas:  aprobadas.length,
                pendientes: rows.filter(r => r.estado_pago === 'PENDIENTE').length,
                rechazadas: rows.filter(r => r.estado_pago === 'RECHAZADO').length,
                ingresos,
            },
            transacciones: rows.map(t => ({
                id:          t.id,
                nombre:      t.nombre,
                correo:      t.correo,
                celular:     t.celular,
                valorPagado: Number(t.valor_pagado),
                saldoBono:   Number(t.saldo_bono),
                metodo:      t.metodo,
                estado:      t.estado_pago,
                fecha:       new Date(t.fecha_creacion).getTime(),
            })),
        });
    } catch (err) {
        console.error('Error en /admin/reportes:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

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

    // Todo el cierre del partido + reparto del Bono Colombia corre en una sola
    // transacción con el partido bloqueado (SELECT FOR UPDATE): si dos
    // peticiones llegan casi al mismo tiempo para el mismo partido (doble clic,
    // reintento automático), la segunda espera a que la primera termine en vez
    // de leer el marcador a medio actualizar o mandar los correos de ganadores
    // dos veces.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM partidos WHERE id = $1 FOR UPDATE', [id]);

        const { rows } = await client.query(
            `UPDATE partidos SET ${campos.join(', ')} WHERE id = $${i} RETURNING id, equipo_local, equipo_visitante, fecha_hora_inicio, goles_local, goles_visitante, estado, fase`,
            valores
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        const partido = rows[0];

        // Bono Colombia $1M: se activa al cerrar un partido de Colombia en fase grupos con marcador
        let bonoColombia = null;
        if (
            partido.estado === 'cerrado' &&
            partido.fase === 'grupos' &&
            partido.goles_local !== null &&
            partido.goles_visitante !== null &&
            (partido.equipo_local.toLowerCase() === 'colombia' || partido.equipo_visitante.toLowerCase() === 'colombia')
        ) {
            const { rows: exactos } = await client.query(
                `SELECT pr.usuario_id, u.nombre, u.correo, u.celular
                 FROM pronosticos pr
                 JOIN usuarios u ON u.id = pr.usuario_id
                 WHERE pr.partido_id = $1
                   AND pr.goles_local = $2
                   AND pr.goles_visitante = $3`,
                [id, partido.goles_local, partido.goles_visitante]
            );
            if (exactos.length > 0) {
                const montoPorGanador = Math.floor(1000000 / exactos.length);
                const nombrePartido = `${partido.equipo_local} ${partido.goles_local} - ${partido.goles_visitante} ${partido.equipo_visitante}`;
                const ganadoresNuevos = [];
                for (const g of exactos) {
                    const { rows: insertado } = await client.query(
                        `INSERT INTO bonos_colombia (partido_id, usuario_id, monto_cop)
                         VALUES ($1, $2, $3) ON CONFLICT (partido_id, usuario_id) DO NOTHING
                         RETURNING id`,
                        [id, g.usuario_id, montoPorGanador]
                    );
                    // Solo se notifica si esta fila se insertó ahora (evita reenviar el
                    // correo si el cierre se reintenta sobre un partido ya procesado).
                    if (insertado.length > 0) {
                        ganadoresNuevos.push(g);
                        if (g.correo) {
                            enviarCorreoBonoColWinner({
                                destinatario: g.correo,
                                nombre: g.nombre,
                                partido: nombrePartido,
                                monto: montoPorGanador,
                            }).catch((err) => console.error('Error enviando email Bono Colombia:', err.message));
                        }
                    }
                }
                bonoColombia = {
                    ganadores: exactos.map((g) => ({ nombre: g.nombre, celular: g.celular })),
                    nuevos: ganadoresNuevos.length,
                    montoPorGanador,
                    totalDistribuido: montoPorGanador * exactos.length,
                };
            } else {
                bonoColombia = { ganadores: [], desierto: true };
            }
        }

        await client.query('COMMIT');

        invalidate('partidos:lista');
        invalidate(`ranking:${id}`);
        invalidate(`resumen:${id}`);
        notificar(id);

        return res.json({ success: true, partido, bonoColombia });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en /admin/partidos PATCH:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
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
        return res.status(500).json({ success: false, error: 'Error interno' });
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

// POST /api/admin/test-whatsapp - diagnóstico paso a paso: buscar/crear suscriptor → sendContent.
// Usa obtenerSubscriberId() de manychatService.js (misma lógica que los envíos reales,
// para no duplicar el manejo de "el suscriptor ya existe en ManyChat").
router.post('/test-whatsapp', async (req, res) => {
    const { celular } = req.body;
    if (!celular) return res.status(400).json({ success: false, error: 'Falta celular' });

    if (!process.env.MANYCHAT_API_KEY) {
        return res.json({ success: false, error: 'MANYCHAT_API_KEY no está configurada en las variables de entorno de Render.' });
    }

    const celularFormateado = `+${formatearCelularWhatsApp(celular)}`;

    // Paso 0: si ya tenemos guardado el subscriber_id para este celular (de un envío
    // exitoso previo), se reutiliza directo y no se le pregunta nada a ManyChat.
    const { rows } = await pool.query(
        `SELECT manychat_subscriber_id FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
        [String(celular || '').replace(/[^0-9+]/g, '')]
    );
    let subscriberId = rows[0]?.manychat_subscriber_id || null;
    let metodo = subscriberId ? 'usuarios.manychat_subscriber_id' : null;
    let diagnostico = null;

    if (!subscriberId) {
        ({ subscriberId, metodo, diagnostico } = await obtenerSubscriberId(celular));
    }

    if (!subscriberId) {
        return res.json({
            success: false,
            paso: 'obtenerSubscriberId — subscriber ID no encontrado',
            celularFormateado,
            error: 'ManyChat no devolvió subscriber_id en ningún intento (createSubscriber ni findBySystemField).',
            detalles: diagnostico,
        });
    }

    // Si el subscriber_id se acaba de resolver (no venía ya guardado), se guarda
    // para que la próxima prueba/envío no tenga que volver a preguntarle a
    // ManyChat. Si el celular no tiene cuenta todavía (p. ej. un número usado
    // solo para esta prueba), se crea una cuenta mínima de prueba — si no, cada
    // reintento volvería a chocar con "ya existe" sin poder recordar el ID.
    if (metodo !== 'usuarios.manychat_subscriber_id') {
        const celularNormalizado = String(celular || '').replace(/[^0-9+]/g, '');
        const { rowCount } = await pool.query(
            `UPDATE usuarios SET manychat_subscriber_id = $1
             WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $2 AND manychat_subscriber_id IS NULL`,
            [String(subscriberId), celularNormalizado]
        );
        if (rowCount === 0) {
            await pool.query(
                `INSERT INTO usuarios (nombre, celular, manychat_subscriber_id) VALUES ('Prueba WhatsApp Admin', $1, $2)
                 ON CONFLICT (celular) DO UPDATE SET manychat_subscriber_id = EXCLUDED.manychat_subscriber_id
                 WHERE usuarios.manychat_subscriber_id IS NULL`,
                [celularNormalizado, String(subscriberId)]
            );
        }
    }

    // Paso 2: sendContent (reusando enviarMensajeManyChat con el subscriberId ya
    // resuelto, para no duplicar tampoco la llamada de envío)
    try {
        await enviarMensajeManyChat({
            celular,
            mensaje: '🧪 Prueba — Polla Mundialista La Retoucherie. Si recibes esto, WhatsApp funciona.',
            subscriberId,
        });
    } catch (err) {
        return res.json({ success: false, paso: 'sendContent', subscriberId, metodo, celularFormateado, error: err.message });
    }

    return res.json({ success: true, paso: 'sendContent', subscriberId, metodo, celularFormateado });
});

// GET /api/admin/ranking-global?limit=100 - top N usuarios por puntos totales
// acumulados en todos los partidos cerrados (misma fórmula de puntaje que
// /api/polla/resultados-finales, pero sin tope de 3 y con datos de contacto).
router.get('/ranking-global', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.nombre, u.celular, u.correo,
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
             GROUP BY u.id, u.nombre, u.celular, u.correo, u.puntos_bonus
             HAVING COALESCE(SUM(
                        CASE
                            WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante
                                 AND pa.goles_local IS NOT NULL THEN 1 ELSE 0
                        END
                    ), 0) > 0 OR COALESCE(u.puntos_bonus, 0) > 0 OR COUNT(pr.id) > 0
             ORDER BY puntos_total DESC, exactos DESC
             LIMIT $1`,
            [limit]
        );

        return res.json({
            success: true,
            ranking: rows.map((u, i) => ({
                posicion: i + 1,
                id: u.id,
                nombre: u.nombre,
                celular: u.celular,
                correo: u.correo,
                puntos: Number(u.puntos_total),
                exactos: Number(u.exactos),
            })),
        });
    } catch (err) {
        console.error('Error en GET /admin/ranking-global:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
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

// GET /api/admin/local-usuarios - listar cuentas Admin QR
router.get('/local-usuarios', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, usuario, nombre_local, correo, activo, fecha_creacion
             FROM local_usuarios ORDER BY fecha_creacion DESC`
        );
        return res.json({ success: true, usuarios: rows });
    } catch (err) {
        console.error('Error en GET /admin/local-usuarios:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/local-usuarios - crear nueva cuenta Admin QR
router.post('/local-usuarios', async (req, res) => {
    const { usuario, password, nombre_local, correo } = req.body;
    if (!usuario || !password) return res.status(400).json({ success: false, error: 'Faltan usuario y contraseña' });

    try {
        const hash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            `INSERT INTO local_usuarios (usuario, password_hash, nombre_local, correo)
             VALUES ($1, $2, $3, $4) RETURNING id, usuario, nombre_local, correo, activo, fecha_creacion`,
            [usuario.trim(), hash, nombre_local?.trim() || null, correo?.trim().toLowerCase() || null]
        );
        return res.json({ success: true, usuario: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'Ese nombre de usuario ya existe' });
        console.error('Error en POST /admin/local-usuarios:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/local-usuarios/:id/reset-password - generar contraseña temporal y mostrarla al admin
router.patch('/local-usuarios/:id/reset-password', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query('SELECT id, nombre_local FROM local_usuarios WHERE id = $1', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'No encontrado' });

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const tempPass = Array.from(crypto.randomBytes(8)).map(b => chars[b % chars.length]).join('');

        const hash = await bcrypt.hash(tempPass, 10);
        await pool.query('UPDATE local_usuarios SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [hash, id]);

        return res.json({ success: true, tempPass });
    } catch (err) {
        console.error('Error en PATCH /admin/local-usuarios/:id/reset-password:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/local-usuarios/:id/toggle - activar/desactivar cuenta
router.patch('/local-usuarios/:id/toggle', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(
            'UPDATE local_usuarios SET activo = NOT activo WHERE id = $1 RETURNING id, activo',
            [id]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'No encontrado' });
        return res.json({ success: true, activo: rows[0].activo });
    } catch (err) {
        console.error('Error en PATCH /admin/local-usuarios/:id/toggle:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/usuarios - lista todos los usuarios registrados con resumen de actividad
router.get('/usuarios', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT
                u.id,
                u.nombre,
                u.correo,
                u.celular,
                u.fecha_registro,
                COUNT(t.id) FILTER (WHERE t.estado_pago = 'APROBADO' AND t.es_test = FALSE) AS compras_aprobadas,
                COALESCE(SUM(t.valor_pagado) FILTER (WHERE t.estado_pago = 'APROBADO' AND t.es_test = FALSE), 0) AS total_pagado,
                MAX(t.fecha_creacion) FILTER (WHERE t.es_test = FALSE) AS ultima_transaccion
             FROM usuarios u
             LEFT JOIN transacciones t ON t.usuario_id = u.id
             GROUP BY u.id
             ORDER BY u.fecha_registro DESC`
        );
        return res.json({ success: true, total: rows.length, usuarios: rows });
    } catch (err) {
        console.error('Error en GET /admin/usuarios:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// DELETE /api/admin/usuarios/:id - borra una cuenta sin compras reales aprobadas
// (cuentas de prueba, registros duplicados, etc.). Si tiene al menos una compra
// aprobada que no sea de prueba, se rechaza para no perder historial real.
// Limpia las tablas dependientes en orden (ninguna tiene ON DELETE CASCADE
// hacia usuarios, salvo passkeys) antes de borrar la fila de usuarios.
router.delete('/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `SELECT COUNT(*)::int AS compras_reales FROM transacciones
             WHERE usuario_id = $1 AND estado_pago = 'APROBADO' AND es_test = FALSE`,
            [id]
        );
        if (rows[0].compras_reales > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'Esta cuenta tiene compras reales aprobadas, no se puede borrar.' });
        }

        await client.query(
            `DELETE FROM redenciones WHERE transaccion_id IN (SELECT id FROM transacciones WHERE usuario_id = $1)`,
            [id]
        );
        await client.query('DELETE FROM pronosticos WHERE usuario_id = $1', [id]);
        await client.query('DELETE FROM compartidas WHERE usuario_id = $1', [id]);
        await client.query('DELETE FROM bonos_colombia WHERE usuario_id = $1', [id]);
        await client.query('DELETE FROM transacciones WHERE usuario_id = $1', [id]);

        const { rowCount } = await client.query('DELETE FROM usuarios WHERE id = $1', [id]);
        if (rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }

        await client.query('COMMIT');
        return res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en DELETE /admin/usuarios/:id:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

// PATCH /api/admin/usuarios/:id/es-test - marca/desmarca una cuenta como de
// prueba (excluida del ranking global y de los resultados finales públicos)
router.patch('/usuarios/:id/es-test', async (req, res) => {
    const { id } = req.params;
    const { es_test } = req.body;

    if (typeof es_test !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Falta es_test (boolean)' });
    }

    try {
        const { rows } = await pool.query(
            'UPDATE usuarios SET es_test = $1 WHERE id = $2 RETURNING id, nombre, es_test',
            [es_test, id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }
        return res.json({ success: true, usuario: rows[0] });
    } catch (err) {
        console.error('Error en PATCH /admin/usuarios/:id/es-test:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
