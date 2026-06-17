const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const localAuth = require('../middleware/localAuth');
const { generarToken } = require('../utils/adminTokens');

const router = express.Router();

// POST /api/local/login - autenticación de cuentas de locales (redención de bonos)
router.post('/login', async (req, res) => {
    const { usuario, password } = req.body;

    if (!usuario || !password) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT id, usuario, nombre_local, password_hash FROM local_usuarios WHERE usuario = $1 AND activo = TRUE',
            [usuario]
        );

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
        }

        const valido = await bcrypt.compare(password, rows[0].password_hash);
        if (!valido) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
        }

        const token = generarToken({ id: rows[0].id, usuario: rows[0].usuario, role: 'LOCAL' });
        return res.json({ success: true, token, usuario: rows[0].usuario, nombreLocal: rows[0].nombre_local });
    } catch (err) {
        console.error('Error en /local/login:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/local/reset-password - envía contraseña temporal al correo del local (no requiere auth)
router.post('/reset-password', async (req, res) => {
    const { correo } = req.body;
    if (!correo) return res.status(400).json({ success: false, error: 'Falta correo' });

    try {
        const { rows } = await pool.query(
            'SELECT id, nombre_local FROM local_usuarios WHERE correo = $1 AND activo = TRUE',
            [correo.trim().toLowerCase()]
        );

        if (rows.length > 0) {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let tempPass = '';
            for (let i = 0; i < 8; i++) tempPass += chars[Math.floor(Math.random() * chars.length)];

            const hash = await bcrypt.hash(tempPass, 10);
            await pool.query('UPDATE local_usuarios SET password_hash = $1 WHERE id = $2', [hash, rows[0].id]);

            const { enviarCorreoResetLocalPassword } = require('../services/emailService');
            enviarCorreoResetLocalPassword({
                destinatario: correo.trim().toLowerCase(),
                nombre: rows[0].nombre_local,
                tempPass,
            }).catch(err => console.error('Error enviando correo reset local:', err.message));
        }

        // Siempre responder success para no revelar si el correo existe
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /local/reset-password:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

router.use(localAuth);

// GET /api/local/bono/:token - datos del bono para verificar y redimir
router.get('/bono/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT t.id, t.valor_pagado, t.saldo_bono,
                    COALESCE(t.saldo_disponible, t.saldo_bono) AS saldo_disponible,
                    t.estado_pago, t.bono_consumido, t.bono_consumido_en,
                    u.nombre, u.celular
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

        // Historial de redenciones anteriores
        const { rows: redenciones } = await pool.query(
            `SELECT r.monto, r.saldo_antes, r.saldo_despues, r.created_at,
                    lu.nombre_local, lu.usuario AS local_usuario
             FROM redenciones r
             JOIN local_usuarios lu ON lu.id = r.local_usuario_id
             WHERE r.transaccion_id = $1
             ORDER BY r.created_at DESC`,
            [bono.id]
        );

        return res.json({
            success: true,
            bono: {
                nombre: bono.nombre,
                celular: bono.celular,
                saldo_bono: bono.saldo_bono,
                saldo_disponible: bono.saldo_disponible,
                valor_pagado: bono.valor_pagado,
                consumido: bono.bono_consumido,
                consumido_en: bono.bono_consumido_en,
                redenciones,
            },
        });
    } catch (err) {
        console.error('Error en /local/bono/:token GET:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/local/bono/redimir - redención parcial o total del saldo del bono
router.post('/bono/redimir', async (req, res) => {
    const { token_acceso, monto } = req.body;
    const localUsuarioId = req.local?.id;

    if (!token_acceso || !monto || Number(monto) <= 0) {
        return res.status(400).json({ success: false, error: 'Datos inválidos' });
    }

    const montoInt = Math.round(Number(monto));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `SELECT t.id, t.saldo_bono,
                    COALESCE(t.saldo_disponible, t.saldo_bono) AS saldo_disponible,
                    t.bono_consumido, t.estado_pago, u.nombre
             FROM transacciones t
             JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.token_acceso = $1
             FOR UPDATE`,
            [token_acceso]
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Bono no encontrado' });
        }

        const b = rows[0];
        if (b.estado_pago !== 'APROBADO') {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, error: 'Bono no aprobado' });
        }

        const saldoAntes = b.saldo_disponible;
        if (montoInt > saldoAntes) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                error: `Saldo insuficiente. Disponible: $${saldoAntes.toLocaleString('es-CO')}`,
            });
        }

        const saldoDespues = saldoAntes - montoInt;

        await client.query(
            `UPDATE transacciones
             SET saldo_disponible   = $1,
                 bono_consumido     = CASE WHEN $1 = 0 THEN TRUE ELSE bono_consumido END,
                 bono_consumido_en  = CASE WHEN $1 = 0 AND NOT bono_consumido THEN now() ELSE bono_consumido_en END
             WHERE token_acceso = $2`,
            [saldoDespues, token_acceso]
        );

        await client.query(
            `INSERT INTO redenciones (transaccion_id, local_usuario_id, monto, saldo_antes, saldo_despues)
             VALUES ($1, $2, $3, $4, $5)`,
            [b.id, localUsuarioId, montoInt, saldoAntes, saldoDespues]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            nombre: b.nombre,
            monto: montoInt,
            saldo_antes: saldoAntes,
            saldo_despues: saldoDespues,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en /local/bono/redimir:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

// POST /api/local/bono/consumir - marca el bono como usado en el local (escaneo del QR)
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
        console.error('Error en /local/bono/consumir:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/local/estadisticas - ingresos totales y valor de los bonos ya
// redimidos en los locales. El valor de bonos redimidos usa valor_pagado
// (lo que pagó el cliente), no saldo_bono, para no incluir el 30% adicional
// que se otorga como bono.
router.get('/estadisticas', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT
                COALESCE(SUM(valor_pagado) FILTER (WHERE estado_pago = 'APROBADO'), 0)::bigint AS ingresos_totales,
                COALESCE(SUM(valor_pagado) FILTER (WHERE bono_consumido = TRUE), 0)::bigint AS valor_bonos_redimidos,
                COUNT(*) FILTER (WHERE bono_consumido = TRUE)::int AS total_bonos_redimidos
             FROM transacciones`
        );

        return res.json({
            success: true,
            ingresosTotales: Number(rows[0].ingresos_totales),
            valorBonosRedimidos: Number(rows[0].valor_bonos_redimidos),
            totalBonosRedimidos: rows[0].total_bonos_redimidos,
        });
    } catch (err) {
        console.error('Error en /local/estadisticas:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
