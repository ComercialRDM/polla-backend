const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { obtenerPlan, valorACentavos } = require('../config/planes');
const { crearPaymentLink } = require('../services/wompiService');

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenReferidoValido(ref) {
    return typeof ref === 'string' && UUID_REGEX.test(ref) ? ref : null;
}

const MIME_TYPES_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!MIME_TYPES_PERMITIDOS.has(file.mimetype)) {
            return cb(new Error('El comprobante debe ser una imagen JPG, PNG, WEBP o HEIC'));
        }
        cb(null, true);
    },
});

// POST /api/transacciones/crear-link
router.post('/crear-link', async (req, res) => {
    const { nombre, correo, celular, partido_id, valor, ref } = req.body;
    const referidoPorToken = tokenReferidoValido(ref);

    if (!nombre || !correo || !celular || !partido_id || !valor) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    const plan = obtenerPlan(Number(valor));
    if (!plan) {
        return res.status(400).json({ success: false, error: 'Valor de bono inválido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verificar que el partido exista y esté activo
        const { rows: partidoRows } = await client.query('SELECT * FROM partidos WHERE id = $1', [partido_id]);
        if (partidoRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        if (partidoRows[0].estado !== 'activo') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Este partido ya no recibe nuevas compras' });
        }

        // Crear o recuperar usuario (por correo o celular)
        let usuario;
        const { rows: existentes } = await client.query(
            'SELECT * FROM usuarios WHERE correo = $1 OR celular = $2',
            [correo, celular]
        );

        if (existentes.length > 0) {
            usuario = existentes[0];
        } else {
            const { rows: nuevoUsuario } = await client.query(
                'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
                [nombre, correo, celular]
            );
            usuario = nuevoUsuario[0];
        }

        // Insertar transacción PENDIENTE
        const { rows: transaccionRows } = await client.query(
            `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, referido_por_token)
             VALUES ($1, $2, 'Wompi', $3, $4, $5, 'PENDIENTE', $6)
             RETURNING *`,
            [usuario.id, partido_id, Number(valor), plan.saldoBono, plan.intentos, referidoPorToken]
        );
        const transaccion = transaccionRows[0];

        // Construir reference
        const reference = `RET-${transaccion.id}-${celular}`;

        // Crear el Payment Link en Wompi
        const amountInCents = valorACentavos(Number(valor));
        const { paymentLinkId, checkoutUrl } = await crearPaymentLink({
            name: `Bono Digital - Polla Mundialista`,
            description: `Bono Digital La Retoucherie de Manuela - $${plan.saldoBono.toLocaleString('es-CO')}`,
            amountInCents,
            reference,
            redirectUrl: `${process.env.FRONTEND_URL}/gracias?token=${transaccion.token_acceso}`,
        });

        // Guardar payment_link_id y reference
        await client.query(
            'UPDATE transacciones SET payment_link_id = $1, reference = $2 WHERE id = $3',
            [paymentLinkId, reference, transaccion.id]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            checkout_url: checkoutUrl,
            reference,
            transaccion_id: transaccion.id,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en crear-link:', err.response?.data || err.message);
        return res.status(500).json({ success: false, error: 'Error interno al crear el link de pago' });
    } finally {
        client.release();
    }
});

// POST /api/transacciones/crear-transferencia
// Registra una transacción PENDIENTE pagada por transferencia bancaria, con foto del comprobante.
// El admin la revisa y aprueba/rechaza manualmente desde el panel.
router.post('/crear-transferencia', upload.single('comprobante'), async (req, res) => {
    const { nombre, correo, celular, partido_id, valor, ref } = req.body;
    const referidoPorToken = tokenReferidoValido(ref);

    if (!nombre || !correo || !celular || !partido_id || !valor) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Debes adjuntar la foto o captura del comprobante de pago' });
    }

    const plan = obtenerPlan(Number(valor));
    if (!plan) {
        return res.status(400).json({ success: false, error: 'Valor de bono inválido' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verificar que el partido exista y esté activo
        const { rows: partidoRows } = await client.query('SELECT * FROM partidos WHERE id = $1', [partido_id]);
        if (partidoRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        if (partidoRows[0].estado !== 'activo') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Este partido ya no recibe nuevas compras' });
        }

        // Crear o recuperar usuario (por correo o celular)
        let usuario;
        const { rows: existentes } = await client.query(
            'SELECT * FROM usuarios WHERE correo = $1 OR celular = $2',
            [correo, celular]
        );

        if (existentes.length > 0) {
            usuario = existentes[0];
        } else {
            const { rows: nuevoUsuario } = await client.query(
                'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
                [nombre, correo, celular]
            );
            usuario = nuevoUsuario[0];
        }

        // Insertar transacción PENDIENTE con el comprobante adjunto
        const { rows: transaccionRows } = await client.query(
            `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, comprobante_imagen, comprobante_mime, referido_por_token)
             VALUES ($1, $2, 'Transferencia', $3, $4, $5, 'PENDIENTE', $6, $7, $8)
             RETURNING id`,
            [usuario.id, partido_id, Number(valor), plan.saldoBono, plan.intentos, req.file.buffer, req.file.mimetype, referidoPorToken]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            transaccion_id: transaccionRows[0].id,
            mensaje: 'Tu comprobante fue recibido. Apenas el equipo de La Retoucherie confirme el pago, recibirás tu bono por correo.',
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en crear-transferencia:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno al registrar la transferencia' });
    } finally {
        client.release();
    }
});

module.exports = router;
