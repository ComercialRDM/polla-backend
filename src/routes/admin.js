const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { generarToken } = require('../utils/adminTokens');
const { aprobarTransaccion, rechazarTransaccion } = require('../services/aprobacionService');
const { enviarCorreoRecompra } = require('../services/emailService');
const { invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');

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
    const { equipo_local, equipo_visitante, fecha_hora_inicio } = req.body;

    if (!equipo_local || !equipo_visitante || !fecha_hora_inicio) {
        return res.status(400).json({ success: false, error: 'Faltan campos: equipo_local, equipo_visitante, fecha_hora_inicio' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO partidos (equipo_local, equipo_visitante, fecha_hora_inicio)
             VALUES ($1, $2, $3)
             RETURNING id, equipo_local, equipo_visitante, fecha_hora_inicio, estado`,
            [equipo_local, equipo_visitante, fecha_hora_inicio]
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
    const { fecha_hora_inicio, goles_local, goles_visitante, estado } = req.body;

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

    if (campos.length === 0) {
        return res.status(400).json({ success: false, error: 'No hay campos para actualizar' });
    }

    valores.push(id);

    try {
        const { rows } = await pool.query(
            `UPDATE partidos SET ${campos.join(', ')} WHERE id = $${i} RETURNING id, equipo_local, equipo_visitante, fecha_hora_inicio, goles_local, goles_visitante, estado`,
            valores
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        invalidate('partidos:lista');
        invalidate(`ranking:${id}`);
        invalidate(`resumen:${id}`);
        notificar(id);
        return res.json({ success: true, partido: rows[0] });
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

// GET /api/admin/bono/:token - datos del bono para verificar antes de marcarlo como consumido
router.get('/bono/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT t.saldo_bono, t.estado_pago, t.bono_consumido, t.bono_consumido_en, u.nombre, u.celular
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.token_acceso = $1
             LIMIT 1`,
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Bono no encontrado' });
        }

        const bono = rows[0];
        if (bono.estado_pago !== 'APROBADO') {
            return res.status(409).json({ success: false, error: 'Este bono no está aprobado' });
        }

        return res.json({
            success: true,
            bono: {
                nombre: bono.nombre,
                celular: bono.celular,
                saldo_bono: bono.saldo_bono,
                consumido: bono.bono_consumido,
                consumido_en: bono.bono_consumido_en,
            },
        });
    } catch (err) {
        console.error('Error en /admin/bono/:token GET:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/bono/consumir - marca el bono como usado en el local (escaneo del QR)
router.post('/bono/consumir', async (req, res) => {
    const { token_acceso } = req.body;
    if (!token_acceso) {
        return res.status(400).json({ success: false, error: 'Falta token_acceso' });
    }

    try {
        const { rows } = await pool.query(
            `UPDATE transacciones SET bono_consumido = TRUE, bono_consumido_en = now()
             WHERE token_acceso = $1 AND estado_pago = 'APROBADO' AND bono_consumido = FALSE
             RETURNING id`,
            [token_acceso]
        );

        if (rows.length === 0) {
            const { rows: existentes } = await pool.query(
                `SELECT t.estado_pago, t.bono_consumido, t.bono_consumido_en, u.nombre
                 FROM transacciones t JOIN usuarios u ON u.id = t.usuario_id
                 WHERE t.token_acceso = $1`,
                [token_acceso]
            );

            if (existentes.length === 0) {
                return res.status(404).json({ success: false, error: 'Bono no encontrado' });
            }
            if (existentes[0].estado_pago !== 'APROBADO') {
                return res.status(409).json({ success: false, error: 'Este bono no está aprobado' });
            }
            return res.status(409).json({
                success: false,
                error: `Este bono ya fue usado por ${existentes[0].nombre} el ${new Date(existentes[0].bono_consumido_en).toLocaleString('es-CO')}`,
            });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /admin/bono/consumir:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
