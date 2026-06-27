const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { obtenerPlan, valorACentavos } = require('../config/planes');
const { generarFirmaIntegridad, WOMPI_PUBLIC_KEY } = require('../services/wompiService');
const { resolverAtribucion } = require('../services/referidosService');
const { obtenerIp } = require('../utils/request');
const { registrarEvento } = require('../services/auditoriaService');

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenReferidoValido(ref) {
    return typeof ref === 'string' && UUID_REGEX.test(ref) ? ref : null;
}

const MIME_TYPES_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// Wompi rechaza un intento de pago si la reference ya fue usada en un intento anterior
// (incluso si quedó abandonado o declinado), así que cada apertura del widget necesita
// una reference nueva — aunque se reutilice la misma transacción PENDIENTE en DB.
function generarReference(transaccionId) {
    return `RET-${transaccionId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Resuelve el usuario de una compra sin fusionar por error a dos personas distintas.
// `celular` es la clave de identidad confiable (UNIQUE NOT NULL en el esquema), así que
// se busca primero por celular. Si no existe y el correo ya pertenece a OTRA cuenta con
// distinto celular, se crea el usuario nuevo sin correo en vez de adjudicar la compra a
// la cuenta ajena (antes el `WHERE correo = $1 OR celular = $2` podía mezclar ambas).
async function resolverUsuarioComprador(client, { nombre, correo, celular }) {
    const { rows: porCelular } = await client.query(
        'SELECT * FROM usuarios WHERE celular = $1',
        [celular]
    );
    if (porCelular.length > 0) return porCelular[0];

    try {
        const { rows } = await client.query(
            'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
            [nombre, correo, celular]
        );
        return rows[0];
    } catch (err) {
        if (err.code === '23505') {
            console.warn(`resolverUsuarioComprador: correo "${correo}" ya registrado con otro celular, se crea cuenta nueva sin correo para celular ${celular}`);
            const { rows } = await client.query(
                'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, NULL, $2) RETURNING *',
                [nombre, celular]
            );
            return rows[0];
        }
        throw err;
    }
}

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
    const { nombre, correo, celular, partido_id, valor, ref, aff_token } = req.body;
    const referidoPorToken = tokenReferidoValido(ref);

    if (!nombre || !correo || !celular || !partido_id || !valor) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    const plan = obtenerPlan(Number(valor));
    if (!plan) {
        return res.status(400).json({ success: false, error: 'Valor de bono inválido' });
    }

    // Atribución de afiliado: se verifica la firma del token aquí, fuera de la
    // transacción de DB, porque solo lee/inserta en referido_clics y nunca debe
    // hacer fallar la compra si el token está vencido o es inválido.
    const atribucion = aff_token ? await resolverAtribucion(aff_token).catch(() => null) : null;

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

        // Crear o recuperar usuario (por celular, la clave de identidad confiable)
        const usuario = await resolverUsuarioComprador(client, { nombre, correo, celular });

        const amountInCents = valorACentavos(Number(valor));

        // Evita crear una segunda transacción si el usuario hace doble clic o reintenta
        // tras perder la conexión: reutiliza la transacción PENDIENTE más reciente
        // (últimos 30 min) para el mismo usuario+partido+valor en vez de duplicar el cargo.
        const { rows: pendienteExistente } = await client.query(
            `SELECT id, reference, token_acceso FROM transacciones
             WHERE usuario_id = $1 AND partido_id = $2 AND valor_pagado = $3
               AND estado_pago = 'PENDIENTE' AND metodo = 'Wompi' AND reference IS NOT NULL
               AND fecha_creacion > now() - interval '30 minutes'
             ORDER BY fecha_creacion DESC LIMIT 1`,
            [usuario.id, partido_id, Number(valor)]
        );
        if (pendienteExistente.length > 0) {
            const existente = pendienteExistente[0];
            const referenceReintento = generarReference(existente.id);
            await client.query('UPDATE transacciones SET reference = $1 WHERE id = $2', [referenceReintento, existente.id]);
            await client.query('COMMIT');
            return res.json({
                success: true,
                widget: {
                    publicKey: WOMPI_PUBLIC_KEY,
                    currency: 'COP',
                    amountInCents,
                    reference: referenceReintento,
                    signature: { integrity: generarFirmaIntegridad({ reference: referenceReintento, amountInCents, currency: 'COP' }) },
                    redirectUrl: `${process.env.FRONTEND_URL}/gracias?token=${existente.token_acceso}`,
                    customerData: { email: correo, fullName: nombre, phoneNumber: celular, phoneNumberPrefix: '+57' },
                },
                reference: referenceReintento,
                transaccion_id: existente.id,
            });
        }

        // Insertar transacción PENDIENTE
        const { rows: transaccionRows } = await client.query(
            `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, referido_por_token, influencer_id, clic_id)
             VALUES ($1, $2, 'Wompi', $3, $4, $5, 'PENDIENTE', $6, $7, $8)
             RETURNING *`,
            [usuario.id, partido_id, Number(valor), plan.saldoBono, plan.intentos, referidoPorToken, atribucion?.influencerId || null, atribucion?.clicId || null]
        );
        const transaccion = transaccionRows[0];

        // Construir reference y firma de integridad (Widget Checkout de Wompi, no Payment Links:
        // este sí soporta pre-llenar nombre/correo/celular del comprador vía customerData)
        const reference = generarReference(transaccion.id);
        const signatureIntegrity = generarFirmaIntegridad({ reference, amountInCents, currency: 'COP' });

        await client.query('UPDATE transacciones SET reference = $1 WHERE id = $2', [reference, transaccion.id]);

        await client.query('COMMIT');

        await registrarEvento({
            tabla: 'transacciones',
            registroId: transaccion.id,
            accion: 'crear_transaccion',
            actor: String(usuario.id),
            despues: { metodo: 'Wompi', valor_pagado: Number(valor), celular, correo },
            ip: obtenerIp(req),
            userAgent: req.headers['user-agent'],
        });

        return res.json({
            success: true,
            widget: {
                publicKey: WOMPI_PUBLIC_KEY,
                currency: 'COP',
                amountInCents,
                reference,
                signature: { integrity: signatureIntegrity },
                redirectUrl: `${process.env.FRONTEND_URL}/gracias?token=${transaccion.token_acceso}`,
                customerData: { email: correo, fullName: nombre, phoneNumber: celular, phoneNumberPrefix: '+57' },
            },
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
    const { nombre, correo, celular, partido_id, valor, ref, aff_token } = req.body;
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

    const atribucion = aff_token ? await resolverAtribucion(aff_token).catch(() => null) : null;

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

        // Crear o recuperar usuario (por celular, la clave de identidad confiable)
        const usuario = await resolverUsuarioComprador(client, { nombre, correo, celular });

        // Insertar transacción PENDIENTE con el comprobante adjunto
        const { rows: transaccionRows } = await client.query(
            `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, comprobante_imagen, comprobante_mime, referido_por_token, influencer_id, clic_id)
             VALUES ($1, $2, 'Transferencia', $3, $4, $5, 'PENDIENTE', $6, $7, $8, $9, $10)
             RETURNING id`,
            [usuario.id, partido_id, Number(valor), plan.saldoBono, plan.intentos, req.file.buffer, req.file.mimetype, referidoPorToken, atribucion?.influencerId || null, atribucion?.clicId || null]
        );

        await client.query('COMMIT');

        await registrarEvento({
            tabla: 'transacciones',
            registroId: transaccionRows[0].id,
            accion: 'crear_transaccion',
            actor: String(usuario.id),
            despues: { metodo: 'Transferencia', valor_pagado: Number(valor), celular, correo },
            ip: obtenerIp(req),
            userAgent: req.headers['user-agent'],
        });

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
