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
const { crearBonosEspeciales, listarBonosEspeciales, enviarInvitacionDifusion, reenviarBonoWhatsApp, obtenerRankingEspeciales } = require('../services/especialesService');
const { registrarEvento } = require('../services/auditoriaService');
const { invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');
const { enviarMensajeManyChat, formatearCelularWhatsApp, obtenerSubscriberId } = require('../services/manychatService');
const { enviarCorreosResultadoPartido } = require('../services/notificacionesService');
const { normalizarCelular } = require('../utils/celular');

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

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/admin/redenciones/resumen?fecha=YYYY-MM-DD - totales del día por sede
// (para el cierre de caja diario). Sin "fecha", usa el día de hoy (hora Bogotá).
router.get('/redenciones/resumen', async (req, res) => {
    const fecha = req.query.fecha;
    if (fecha && !FECHA_REGEX.test(fecha)) {
        return res.status(400).json({ success: false, error: 'Formato de fecha inválido (YYYY-MM-DD)' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT COALESCE(r.sede, 'Sin sede') AS sede,
                    COUNT(*)::int AS cantidad,
                    COALESCE(SUM(r.monto), 0)::bigint AS total
             FROM redenciones r
             WHERE date(r.created_at AT TIME ZONE 'America/Bogota') = COALESCE($1::date, (now() AT TIME ZONE 'America/Bogota')::date)
             GROUP BY sede
             ORDER BY sede`,
            [fecha || null]
        );

        const porSede = rows.map((r) => ({ sede: r.sede, cantidad: r.cantidad, total: Number(r.total) }));
        const totalGeneral = porSede.reduce((acc, r) => acc + r.total, 0);
        const cantidadGeneral = porSede.reduce((acc, r) => acc + r.cantidad, 0);

        return res.json({ success: true, fecha: fecha || null, porSede, totalGeneral, cantidadGeneral });
    } catch (err) {
        console.error('Error en /admin/redenciones/resumen:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/redenciones/export?desde=YYYY-MM-DD&hasta=YYYY-MM-DD - listado
// detallado de canjes para auditar contra los servicios reclamados en cada sede.
router.get('/redenciones/export', async (req, res) => {
    const { desde, hasta } = req.query;
    if (!desde || !hasta || !FECHA_REGEX.test(desde) || !FECHA_REGEX.test(hasta)) {
        return res.status(400).json({ success: false, error: 'Faltan o son inválidas "desde"/"hasta" (YYYY-MM-DD)' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT r.created_at, r.sede, r.monto, r.saldo_antes, r.saldo_despues,
                    u.nombre, u.celular, t.valor_pagado, t.saldo_bono, t.token_acceso,
                    lu.nombre_local, lu.usuario AS local_usuario
             FROM redenciones r
             JOIN transacciones t ON t.id = r.transaccion_id
             JOIN usuarios u ON u.id = t.usuario_id
             JOIN local_usuarios lu ON lu.id = r.local_usuario_id
             WHERE date(r.created_at AT TIME ZONE 'America/Bogota') BETWEEN $1::date AND $2::date
             ORDER BY r.created_at ASC`,
            [desde, hasta]
        );

        return res.json({
            success: true,
            redenciones: rows.map((r) => ({
                fechaHora: r.created_at,
                sede: r.sede || 'Sin sede',
                nombre: r.nombre,
                celular: r.celular,
                monto: Number(r.monto),
                saldoAntes: Number(r.saldo_antes),
                saldoDespues: Number(r.saldo_despues),
                valorPagado: Number(r.valor_pagado),
                saldoBono: Number(r.saldo_bono),
                tokenAcceso: r.token_acceso,
                atendidoPor: r.nombre_local || r.local_usuario,
            })),
        });
    } catch (err) {
        console.error('Error en /admin/redenciones/export:', err);
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
            // LEFT JOIN (no INNER) a propósito: los pronósticos "flash" (promoción sin
            // bono) tienen transaccion_id NULL y deben seguir contando. Solo se excluyen
            // los que sí están ligados a una transacción de prueba o Bono Especial.
            const { rows: exactos } = await client.query(
                `SELECT pr.usuario_id, u.nombre, u.correo, u.celular
                 FROM pronosticos pr
                 JOIN usuarios u ON u.id = pr.usuario_id
                 LEFT JOIN transacciones t ON t.id = pr.transaccion_id
                 WHERE pr.partido_id = $1
                   AND pr.goles_local = $2
                   AND pr.goles_visitante = $3
                   AND COALESCE(t.es_test, FALSE) = FALSE
                   AND COALESCE(t.es_especial, FALSE) = FALSE`,
                [id, partido.goles_local, partido.goles_visitante]
            );
            if (exactos.length > 0) {
                // Si hay más de 10 acertantes exactos, se sortea entre todos ellos
                // y solo 10 se llevan el Bono Colombia ($100.000 cada uno = $1.000.000
                // en total). Con 10 o menos acertantes, el millón se divide en
                // partes iguales entre todos (sin sorteo).
                const sorteoRealizado = exactos.length > 10;
                const ganadoresElegidos = sorteoRealizado
                    ? [...exactos].sort(() => Math.random() - 0.5).slice(0, 10)
                    : exactos;
                const montoPorGanador = sorteoRealizado ? 100000 : Math.floor(1000000 / exactos.length);
                const nombrePartido = `${partido.equipo_local} ${partido.goles_local} - ${partido.goles_visitante} ${partido.equipo_visitante}`;
                const ganadoresNuevos = [];
                for (const g of ganadoresElegidos) {
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
                    ganadores: ganadoresElegidos.map((g) => ({ nombre: g.nombre, celular: g.celular })),
                    nuevos: ganadoresNuevos.length,
                    montoPorGanador,
                    totalDistribuido: montoPorGanador * ganadoresElegidos.length,
                    sorteoRealizado,
                    totalAcertantes: exactos.length,
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

        // Correo de "resultado del partido + recompra" (reemplaza las notificaciones
        // de inicio de partido/gol que antes se mandaban por WhatsApp). Fuera de la
        // transacción a propósito: no debe bloquear la respuesta ni revertir el
        // cierre del partido si falla el correo de alguien. La función es
        // idempotente (tabla recompra_enviada), así que reintentar el cierre no
        // duplica envíos.
        if (partido.estado === 'cerrado') {
            enviarCorreosResultadoPartido(partido)
                .catch((err) => console.error('Error enviando correos de resultado de partido:', err.message));
        }

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

// POST /api/admin/especiales/crear
// Crea Bonos Especiales (es_especial = TRUE) para influenciadores/creadores
// de contenido: cupos para predecir + bono REAL de servicios (válido en
// tienda), pero excluidos del ranking de premios y del Bono Colombia.
// Body: { personas: [{ nombre, celular, correo? }], valorBono?, intentos? }
router.post('/especiales/crear', async (req, res) => {
    const { personas, valorBono, intentos } = req.body;

    if (!Array.isArray(personas) || personas.length === 0) {
        return res.status(400).json({ success: false, error: 'Falta el campo personas (array)' });
    }

    try {
        const resultado = await crearBonosEspeciales({ personas, valorBono, intentos });
        return res.json({ success: true, ...resultado });
    } catch (err) {
        console.error('Error en /admin/especiales/crear:', err);
        return res.status(500).json({ success: false, error: err.message || 'Error interno' });
    }
});

// GET /api/admin/especiales - lista los Bonos Especiales ya creados
router.get('/especiales', async (req, res) => {
    try {
        const bonos = await listarBonosEspeciales();
        return res.json({ success: true, bonos });
    } catch (err) {
        console.error('Error en /admin/especiales:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/especiales/:id/invitar
// Envía por WhatsApp el mensaje de invitación a difundir el concurso (pasos
// para participar, beneficios de La Retoucherie y su link de referido).
router.post('/especiales/:id/invitar', async (req, res) => {
    try {
        const resultado = await enviarInvitacionDifusion(Number(req.params.id));
        return res.json({ success: true, ...resultado });
    } catch (err) {
        console.error('Error en /admin/especiales/:id/invitar:', err);
        return res.status(500).json({ success: false, error: err.message || 'Error interno' });
    }
});

// POST /api/admin/especiales/:id/reenviar-bono
// Reenvía la confirmación de bono por WhatsApp usando la plantilla aprobada.
// Útil cuando el envío inicial falló porque el suscriptor no existía en ManyChat.
router.post('/especiales/:id/reenviar-bono', async (req, res) => {
    try {
        const resultado = await reenviarBonoWhatsApp(Number(req.params.id));
        return res.json({ success: true, ...resultado });
    } catch (err) {
        console.error('Error en /admin/especiales/:id/reenviar-bono:', err);
        return res.status(500).json({ success: false, error: err.message || 'Error interno' });
    }
});

// GET /api/admin/influencers/registros - solicitudes del formulario público
// de influencers (/influencers), pendientes de que se les cree el Bono
// Especial manualmente.
router.get('/influencers/registros', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, nombre, correo, celular, red_contenido, atendido, fecha_registro,
                    (foto_imagen IS NOT NULL) AS tiene_foto
             FROM influencer_registros ORDER BY fecha_registro DESC`
        );
        return res.json({ success: true, registros: rows });
    } catch (err) {
        console.error('Error en /admin/influencers/registros:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/influencers/registros/:id/foto - foto adjunta al registro
// (si subió y autorizó). Requiere sesión admin, igual que el comprobante de pago.
router.get('/influencers/registros/:id/foto', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT foto_imagen, foto_mime FROM influencer_registros WHERE id = $1',
            [req.params.id]
        );
        if (rows.length === 0 || !rows[0].foto_imagen) {
            return res.status(404).json({ success: false, error: 'No hay foto para este registro' });
        }
        res.set('Content-Type', rows[0].foto_mime || 'image/jpeg');
        return res.send(rows[0].foto_imagen);
    } catch (err) {
        console.error('Error en /admin/influencers/registros/:id/foto:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/influencers/registros/:id - marca una solicitud como
// atendida (ya se le creó/envió el Bono Especial) o la vuelve a pendiente.
router.patch('/influencers/registros/:id', async (req, res) => {
    try {
        await pool.query(
            'UPDATE influencer_registros SET atendido = $1 WHERE id = $2',
            [!!req.body.atendido, req.params.id]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /admin/influencers/registros/:id:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/ventas-por-canal?fecha_inicio=&fecha_fin= - resumen de
// ventas agrupado por attribution_group (email, sms, whatsapp, influencer,
// friend, paid_ads, organic_social, organic_search, direct, referral). Las
// fechas son opcionales: sin ellas, trae todo el historico.
router.get('/ventas-por-canal', async (req, res) => {
    const { fecha_inicio, fecha_fin } = req.query;
    try {
        const condiciones = [`estado_pago = 'APROBADO'`, `es_test = FALSE`];
        const valores = [];
        if (fecha_inicio && fecha_fin) {
            valores.push(fecha_inicio, fecha_fin);
            condiciones.push(`date(fecha_creacion AT TIME ZONE 'America/Bogota') BETWEEN $1::date AND $2::date`);
        }

        const { rows } = await pool.query(
            `SELECT COALESCE(attribution_group, 'sin_clasificar') AS attribution_group,
                    COUNT(*) AS total_ventas,
                    COALESCE(SUM(valor_pagado), 0) AS ingresos
             FROM transacciones
             WHERE ${condiciones.join(' AND ')}
             GROUP BY attribution_group
             ORDER BY ingresos DESC`,
            valores
        );

        return res.json({
            success: true,
            canales: rows.map((r) => ({
                canal: r.attribution_group,
                totalVentas: Number(r.total_ventas),
                ingresos: Number(r.ingresos),
            })),
        });
    } catch (err) {
        console.error('Error en /admin/ventas-por-canal:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/ventas-por-campana - detalle por utm_source/utm_medium/
// utm_campaign, para bajar un nivel mas que ventas-por-canal (ej. distinguir
// "campaña julio" de "campaña agosto" dentro del mismo canal email).
router.get('/ventas-por-campana', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT COALESCE(utm_source, '(sin utm_source)') AS utm_source,
                    COALESCE(utm_medium, '(sin utm_medium)') AS utm_medium,
                    COALESCE(utm_campaign, '(sin utm_campaign)') AS utm_campaign,
                    COUNT(*) AS total_ventas,
                    COALESCE(SUM(valor_pagado), 0) AS ingresos
             FROM transacciones
             WHERE estado_pago = 'APROBADO' AND es_test = FALSE
               AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
             GROUP BY utm_source, utm_medium, utm_campaign
             ORDER BY ingresos DESC`
        );
        return res.json({
            success: true,
            campanas: rows.map((r) => ({
                utmSource: r.utm_source,
                utmMedium: r.utm_medium,
                utmCampaign: r.utm_campaign,
                totalVentas: Number(r.total_ventas),
                ingresos: Number(r.ingresos),
            })),
        });
    } catch (err) {
        console.error('Error en /admin/ventas-por-campana:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/ranking-amigos - ranking de "invita amigos" (referido_por_token),
// el equivalente a /afiliados pero para el sistema de amigos, que no tiene
// tabla propia con nombre/comision: se identifica al amigo por la transacción
// cuyo token_acceso coincide con el referido_por_token de las compras que generó.
router.get('/ranking-amigos', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u.id AS usuario_id, u.nombre, u.celular,
                    COUNT(t.id) AS total_referidos,
                    COALESCE(SUM(t.valor_pagado), 0) AS ingresos_generados
             FROM transacciones t
             JOIN transacciones t_referente ON t_referente.token_acceso = t.referido_por_token
             JOIN usuarios u ON u.id = t_referente.usuario_id
             WHERE t.estado_pago = 'APROBADO' AND t.es_test = FALSE AND t.referido_por_token IS NOT NULL
             GROUP BY u.id, u.nombre, u.celular
             ORDER BY ingresos_generados DESC`
        );
        return res.json({
            success: true,
            amigos: rows.map((r) => ({
                usuarioId: r.usuario_id,
                nombre: r.nombre,
                celular: r.celular,
                totalReferidos: Number(r.total_referidos),
                ingresosGenerados: Number(r.ingresos_generados),
            })),
        });
    } catch (err) {
        console.error('Error en /admin/ranking-amigos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/afiliados - resumen por influencer: código, % comisión,
// clics, ventas atribuidas y comisión generada/pagada. Vista de control del
// programa de afiliados (distinta del ranking de puntos de la Polla).
router.get('/afiliados', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT i.id, i.codigo_afiliado, i.porcentaje_comision, i.activo,
                    u.nombre, u.celular,
                    COUNT(DISTINCT c.id) AS total_clics,
                    COUNT(DISTINCT co.id) AS total_ventas,
                    COALESCE(SUM(co.monto_comision), 0) AS comision_generada,
                    COALESCE(SUM(co.monto_comision) FILTER (WHERE co.estado = 'PENDIENTE'), 0) AS comision_pendiente
             FROM influencers i
             JOIN usuarios u ON u.id = i.usuario_id
             LEFT JOIN referido_clics c ON c.influencer_id = i.id
             LEFT JOIN comisiones co ON co.influencer_id = i.id
             GROUP BY i.id, i.codigo_afiliado, i.porcentaje_comision, i.activo, u.nombre, u.celular
             ORDER BY comision_generada DESC`
        );
        return res.json({ success: true, afiliados: rows });
    } catch (err) {
        console.error('Error en /admin/afiliados:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/afiliados/:id - ajustar % de comisión o activar/desactivar
// un influencer como afiliado (no afecta su Bono Especial ni su ranking).
router.patch('/afiliados/:id', async (req, res) => {
    const { porcentaje_comision, activo } = req.body;
    try {
        const { rows: antesRows } = await pool.query('SELECT * FROM influencers WHERE id = $1', [req.params.id]);
        if (antesRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Afiliado no encontrado' });
        }

        const { rows } = await pool.query(
            `UPDATE influencers
             SET porcentaje_comision = COALESCE($1, porcentaje_comision),
                 activo = COALESCE($2, activo)
             WHERE id = $3
             RETURNING *`,
            [porcentaje_comision != null ? Number(porcentaje_comision) : null, activo != null ? !!activo : null, req.params.id]
        );

        await registrarEvento({
            tabla: 'influencers',
            registroId: req.params.id,
            accion: 'editar_afiliado',
            actor: req.admin?.usuario,
            antes: antesRows[0],
            despues: rows[0],
        });

        return res.json({ success: true, afiliado: rows[0] });
    } catch (err) {
        console.error('Error en /admin/afiliados/:id:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/comisiones?estado=PENDIENTE - lista comisiones individuales
// (cada venta atribuida), para revisar antes de pagar.
router.get('/comisiones', async (req, res) => {
    const { estado } = req.query;
    try {
        const { rows } = await pool.query(
            `SELECT co.id, co.transaccion_id, co.monto_venta, co.porcentaje, co.monto_comision, co.estado, co.creado_en,
                    i.codigo_afiliado, u.nombre AS influencer_nombre
             FROM comisiones co
             JOIN influencers i ON i.id = co.influencer_id
             JOIN usuarios u ON u.id = i.usuario_id
             WHERE ($1::text IS NULL OR co.estado = $1)
             ORDER BY co.creado_en DESC`,
            [estado || null]
        );
        return res.json({ success: true, comisiones: rows });
    } catch (err) {
        console.error('Error en /admin/comisiones:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/comisiones/:id - marca una comisión como PAGADA o ANULADA.
// Ledger append-only: no se borra ni se recalcula, solo cambia el estado.
router.patch('/comisiones/:id', async (req, res) => {
    const { estado } = req.body;
    if (!['PAGADA', 'ANULADA', 'PENDIENTE'].includes(estado)) {
        return res.status(400).json({ success: false, error: 'Estado inválido' });
    }

    try {
        const { rows: antesRows } = await pool.query('SELECT * FROM comisiones WHERE id = $1', [req.params.id]);
        if (antesRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Comisión no encontrada' });
        }

        const { rows } = await pool.query(
            'UPDATE comisiones SET estado = $1 WHERE id = $2 RETURNING *',
            [estado, req.params.id]
        );

        await registrarEvento({
            tabla: 'comisiones',
            registroId: req.params.id,
            accion: `comision_${estado.toLowerCase()}`,
            actor: req.admin?.usuario,
            antes: antesRows[0],
            despues: rows[0],
        });

        return res.json({ success: true, comision: rows[0] });
    } catch (err) {
        console.error('Error en /admin/comisiones/:id:', err);
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
    // Se normaliza igual que el resto de la app (sin "+57"/"57") para que
    // "+573053888885" y "3053888885" encuentren la misma fila guardada.
    const { rows } = await pool.query(
        `SELECT manychat_subscriber_id FROM usuarios WHERE regexp_replace(celular, '[^0-9]', '', 'g') = $1`,
        [normalizarCelular(celular)]
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
        const celularNormalizado = normalizarCelular(celular);
        const { rowCount } = await pool.query(
            `UPDATE usuarios SET manychat_subscriber_id = $1
             WHERE regexp_replace(celular, '[^0-9]', '', 'g') = $2 AND manychat_subscriber_id IS NULL`,
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
                                WHEN 'dieciseisavos' THEN 200
                                WHEN 'octavos'       THEN 200
                                WHEN 'cuartos'       THEN 600
                                WHEN 'semifinal'     THEN 600
                                WHEN 'final'         THEN 1000
                                ELSE 100 END
                            WHEN pr.goles_local IS NOT NULL AND pa.goles_local IS NOT NULL
                                 AND SIGN(pr.goles_local - pr.goles_visitante) = SIGN(pa.goles_local - pa.goles_visitante)
                                 AND NOT (pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante)
                            THEN CASE pa.fase
                                WHEN 'grupos'        THEN 50
                                WHEN 'dieciseisavos' THEN 100
                                WHEN 'octavos'       THEN 100
                                WHEN 'cuartos'       THEN 300
                                WHEN 'semifinal'     THEN 300
                                WHEN 'final'         THEN 500
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

// GET /api/admin/ranking-especiales - ranking SOLO entre cuentas de Bono
// Especial (influenciadores/creadores de contenido), para que compitan entre
// ellos sin mezclarse con el ranking de premios real. Misma fórmula de
// puntaje que /ranking-global.
router.get('/ranking-especiales', async (req, res) => {
    try {
        const ranking = await obtenerRankingEspeciales();
        return res.json({ success: true, ranking });
    } catch (err) {
        console.error('Error en GET /admin/ranking-especiales:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/flash-ganadores - identifica el ganador de cada partido de la
// promoción relámpago (pronosticos.es_flash = TRUE): el primero, por hora de
// registro, cuyo pronóstico coincide con el marcador final. Solo se puede
// determinar una vez el partido tiene marcador (estado 'cerrado').
router.get('/flash-ganadores', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT p.id AS partido_id, p.equipo_local, p.equipo_visitante, p.fecha_hora_inicio,
                    p.estado, p.goles_local, p.goles_visitante,
                    pr.id AS pronostico_id, pr.goles_local AS pred_local, pr.goles_visitante AS pred_visitante, pr.created_at,
                    u.id AS usuario_id, u.nombre, u.celular, u.correo
             FROM pronosticos pr
             JOIN partidos p ON p.id = pr.partido_id
             JOIN usuarios u ON u.id = pr.usuario_id
             WHERE pr.es_flash = TRUE
             ORDER BY p.fecha_hora_inicio ASC, pr.created_at ASC`
        );

        const partidosMap = new Map();
        for (const r of rows) {
            if (!partidosMap.has(r.partido_id)) {
                partidosMap.set(r.partido_id, {
                    partido_id: r.partido_id,
                    equipo_local: r.equipo_local,
                    equipo_visitante: r.equipo_visitante,
                    fecha_hora_inicio: r.fecha_hora_inicio,
                    estado: r.estado,
                    goles_local: r.goles_local,
                    goles_visitante: r.goles_visitante,
                    pronosticos: [],
                });
            }
            partidosMap.get(r.partido_id).pronosticos.push({
                pronostico_id: r.pronostico_id,
                usuario_id: r.usuario_id,
                nombre: r.nombre,
                celular: r.celular,
                correo: r.correo,
                pred_local: r.pred_local,
                pred_visitante: r.pred_visitante,
                created_at: r.created_at,
            });
        }

        // El array de pronósticos de cada partido ya viene ordenado por
        // created_at ASC (orden de la consulta), así que el primer pronóstico
        // que coincide con el marcador final es el ganador por orden de llegada.
        const partidos = [...partidosMap.values()].map((p) => {
            let ganador = null;
            if (p.goles_local !== null && p.goles_visitante !== null) {
                ganador = p.pronosticos.find(
                    (pr) => pr.pred_local === p.goles_local && pr.pred_visitante === p.goles_visitante
                ) || null;
            }
            return {
                ...p,
                ganador,
                pronosticos: p.pronosticos.map((pr) => ({
                    ...pr,
                    es_ganador: !!ganador && ganador.pronostico_id === pr.pronostico_id,
                })),
            };
        });

        return res.json({ success: true, partidos });
    } catch (err) {
        console.error('Error en GET /admin/flash-ganadores:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/ranking-final - calcula el podio final del torneo aplicando
// los 3 criterios de desempate (puntaje total → puntaje en la Gran Final →
// exactos en Semifinales) y resuelve empates de podio: si el grupo empatado
// tiene 10 personas o menos, reparte el/los premios de las posiciones que
// ocupa en partes iguales; si tiene más de 10, sortea 10 ganadores entre
// ellos. Es de solo lectura — no inserta nada ni envía mensajes, para que el
// Operador revise el resultado y notifique manualmente (igual que hoy).
router.get('/ranking-final', async (req, res) => {
    try {
        const { rows: pozoRows } = await pool.query('SELECT primero, segundo, tercero FROM pozo_premios WHERE id = 1');
        const base = pozoRows[0] || { primero: 2000000, segundo: 1000000, tercero: 500000 };
        const PREMIOS = [Number(base.primero), Number(base.segundo), Number(base.tercero)];

        const { rows } = await pool.query(
            `SELECT u.id, u.nombre, u.celular, u.correo,
                    COALESCE(SUM(
                        CASE
                            WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante AND pa.goles_local IS NOT NULL
                            THEN CASE pa.fase
                                WHEN 'grupos' THEN 100 WHEN 'dieciseisavos' THEN 200 WHEN 'octavos' THEN 200
                                WHEN 'cuartos' THEN 600 WHEN 'semifinal' THEN 600 WHEN 'final' THEN 1000 ELSE 100 END
                            WHEN pr.goles_local IS NOT NULL AND pa.goles_local IS NOT NULL
                                 AND SIGN(pr.goles_local - pr.goles_visitante) = SIGN(pa.goles_local - pa.goles_visitante)
                                 AND NOT (pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante)
                            THEN CASE pa.fase
                                WHEN 'grupos' THEN 50 WHEN 'dieciseisavos' THEN 100 WHEN 'octavos' THEN 100
                                WHEN 'cuartos' THEN 300 WHEN 'semifinal' THEN 300 WHEN 'final' THEN 500 ELSE 50 END
                            ELSE 0
                        END
                    ), 0) + COALESCE(u.puntos_bonus, 0) AS puntos_total,
                    COUNT(CASE WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante AND pa.goles_local IS NOT NULL THEN 1 END) AS exactos_total,
                    COALESCE(SUM(
                        CASE
                            WHEN pa.fase = 'final' AND pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante AND pa.goles_local IS NOT NULL THEN 1000
                            WHEN pa.fase = 'final' AND pr.goles_local IS NOT NULL AND pa.goles_local IS NOT NULL
                                 AND SIGN(pr.goles_local - pr.goles_visitante) = SIGN(pa.goles_local - pa.goles_visitante)
                                 AND NOT (pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante)
                            THEN 500
                            ELSE 0
                        END
                    ), 0) AS puntos_final,
                    COUNT(CASE WHEN pa.fase = 'semifinal' AND pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante AND pa.goles_local IS NOT NULL THEN 1 END) AS exactos_semifinal
             FROM usuarios u
             LEFT JOIN pronosticos pr ON pr.usuario_id = u.id
             LEFT JOIN partidos pa ON pa.id = pr.partido_id AND pa.estado = 'cerrado'
             WHERE u.es_test = FALSE
               AND u.id NOT IN (SELECT usuario_id FROM transacciones WHERE es_especial = TRUE)
             GROUP BY u.id, u.nombre, u.celular, u.correo, u.puntos_bonus
             HAVING COUNT(pr.id) > 0 OR COALESCE(u.puntos_bonus, 0) > 0`
        );

        const ordenados = rows
            .map((u) => ({
                id: u.id,
                nombre: u.nombre,
                celular: u.celular,
                correo: u.correo,
                puntos_total: Number(u.puntos_total),
                puntos_final: Number(u.puntos_final),
                exactos_semifinal: Number(u.exactos_semifinal),
                exactos_total: Number(u.exactos_total),
            }))
            .sort((a, b) =>
                b.puntos_total - a.puntos_total ||
                b.puntos_final - a.puntos_final ||
                b.exactos_semifinal - a.exactos_semifinal
            );

        // Agrupa usuarios consecutivos que empatan en los 3 criterios de desempate.
        const bloques = [];
        for (const u of ordenados) {
            const ultimo = bloques[bloques.length - 1];
            if (
                ultimo &&
                ultimo.usuarios[0].puntos_total === u.puntos_total &&
                ultimo.usuarios[0].puntos_final === u.puntos_final &&
                ultimo.usuarios[0].exactos_semifinal === u.exactos_semifinal
            ) {
                ultimo.usuarios.push(u);
            } else {
                bloques.push({ usuarios: [u] });
            }
        }

        // Cada bloque ocupa tantas posiciones como usuarios tiene, en el orden en
        // que aparecen. Solo importan las posiciones 1-3 (donde hay premio).
        const podio = [];
        let posicionActual = 1;
        for (const bloque of bloques) {
            const inicio = posicionActual;
            const fin = posicionActual + bloque.usuarios.length - 1;
            posicionActual = fin + 1;

            const premiosDelBloque = [];
            for (let pos = inicio; pos <= Math.min(fin, 3); pos++) premiosDelBloque.push(PREMIOS[pos - 1]);
            if (premiosDelBloque.length === 0) break;

            const premioTotal = premiosDelBloque.reduce((a, b) => a + b, 0);
            const sorteoRealizado = bloque.usuarios.length > 10;
            const ganadores = sorteoRealizado
                ? [...bloque.usuarios].sort(() => Math.random() - 0.5).slice(0, 10)
                : bloque.usuarios;
            const montoPorGanador = Math.floor(premioTotal / ganadores.length);

            podio.push({
                puestos: inicio === fin ? `${inicio}°` : `${inicio}°-${fin}°`,
                premio_total: premioTotal,
                empatados: bloque.usuarios.length,
                sorteo_realizado: sorteoRealizado,
                monto_por_ganador: montoPorGanador,
                ganadores: ganadores.map((g) => ({
                    id: g.id, nombre: g.nombre, celular: g.celular, correo: g.correo,
                    puntos_total: g.puntos_total, puntos_final: g.puntos_final, exactos_semifinal: g.exactos_semifinal,
                })),
                no_sorteados: sorteoRealizado
                    ? bloque.usuarios.filter((u) => !ganadores.includes(u)).map((u) => ({ id: u.id, nombre: u.nombre }))
                    : [],
            });

            if (fin >= 3) break;
        }

        return res.json({
            success: true,
            premios_base: { primero: PREMIOS[0], segundo: PREMIOS[1], tercero: PREMIOS[2] },
            podio,
            total_participantes: ordenados.length,
        });
    } catch (err) {
        console.error('Error en GET /admin/ranking-final:', err);
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
