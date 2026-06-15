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

router.use(localAuth);

// GET /api/local/bono/:token - datos del bono para verificar antes de marcarlo como consumido
router.get('/bono/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const { rows } = await pool.query(
            `SELECT t.valor_pagado, t.saldo_bono, t.estado_pago, t.bono_consumido, t.bono_consumido_en, u.nombre, u.celular
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
                valor_pagado: bono.valor_pagado,
                consumido: bono.bono_consumido,
                consumido_en: bono.bono_consumido_en,
            },
        });
    } catch (err) {
        console.error('Error en /local/bono/:token GET:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
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
