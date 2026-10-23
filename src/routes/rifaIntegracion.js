const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { generarBoleta } = require('../services/rifaBoletaImagen');
const { corteDe } = require('../services/rifaCortes');

// Recepción automática de facturas de Alegra (las 3 sedes) enviadas por n8n.
//
// POST /api/rifa/integracion/facturas   (header X-Integracion-Secret)
// body: {
//   sede: 'Viva' | 'Aranjuez' | 'Buenavista',
//   facturas: [{ id_alegra, numero, fecha: 'YYYY-MM-DD', total, saldo, estado,
//                cliente: { nombre, identificacion, celular, correo } }],
//   notas_credito: [{ numero, factura_numero, fecha }]
// }
//
// Reglas (acordadas con el negocio):
// - Participan facturas del 01-oct al 20-dic-2026, PAGADAS (saldo 0): una boleta
//   por cada $100.000 pagados.
// - Factura anulada (estado void) o con nota crédito → sus boletas se anulan.
// - Las boletas nuevas quedan PENDIENTES de aprobación en el corte horario
//   correspondiente; nada se envía sin aprobación.
// - Si Alegra trae un celular para una boleta que aún no se ha enviado y que no
//   lo tenía (o era otro), se actualiza, se regenera la imagen y vuelve a revisión.
// - Idempotente: reenviar la misma factura no duplica boletas.

const DESDE = '2026-10-01';
const HASTA = '2026-12-20';
const VALOR_BOLETA = 100000;
const SEDES = { viva: 'Viva', aranjuez: 'Aranjuez', buenavista: 'Buenavista' };

pool.query(`
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS sede_origen VARCHAR(30);
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS origen VARCHAR(20) NOT NULL DEFAULT 'sheet';
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS corte TIMESTAMPTZ;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS anulada BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS anulada_en TIMESTAMPTZ;
    ALTER TABLE rifa_boletas ADD COLUMN IF NOT EXISTS anulada_motivo TEXT;
    CREATE INDEX IF NOT EXISTS rifa_boletas_corte ON rifa_boletas (corte);
    CREATE TABLE IF NOT EXISTS rifa_facturas (
        sede VARCHAR(30) NOT NULL,
        numero_digitos VARCHAR(30) NOT NULL,
        numero VARCHAR(40) NOT NULL,
        id_alegra VARCHAR(40),
        fecha DATE,
        total NUMERIC(14,2),
        saldo NUMERIC(14,2),
        estado VARCHAR(20),
        cliente JSONB,
        resultado VARCHAR(40),
        recibido_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (sede, numero_digitos)
    );
    CREATE TABLE IF NOT EXISTS rifa_cancelados (
        celular VARCHAR(10) PRIMARY KEY,
        nombre VARCHAR(200),
        fuente VARCHAR(60),
        cargado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`).catch((err) => console.error('[rifa-integracion] Error migrando:', err.message));

const digitos = (s) => String(s || '').replace(/\D/g, '');

function normCelular(c) {
    const d = digitos(c).replace(/^57(?=3\d{9}$)/, '');
    return /^3\d{9}$/.test(d) ? d : '';
}
const fmtCelular = (d) => (d ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : '');
function fmtCedula(c) {
    const d = digitos(c);
    return d ? Number(d).toLocaleString('de-DE') : '';
}
function limpiarNombre(n) {
    const w = String(n || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    const h = w.length / 2;
    if (w.length % 2 === 0 && h && w.slice(0, h).join(' ') === w.slice(h).join(' ')) return w.slice(0, h).join(' ');
    return w.join(' ');
}

async function observaciones(b) {
    const obs = [];
    if (b.nombre.split(' ').length < 2) obs.push(`Nombre incompleto: '${b.nombre}'`);
    const dc = digitos(b.cedula).length;
    if (dc < 5 || dc > 10) obs.push(`Cédula con longitud inusual: ${b.cedula}`);
    return obs.join(' · ') || null;
}

async function canalPara(client, celular) {
    if (!celular) return ['otro_medio', 'Sin celular'];
    const { rows } = await client.query('SELECT 1 FROM rifa_cancelados WHERE celular = $1', [celular]);
    return rows.length ? ['otro_medio', 'Canceló la suscripción de WhatsApp en ManyChat'] : ['whatsapp', null];
}

async function anularFactura(client, sede, numDig, motivo) {
    const { rows } = await client.query(
        `UPDATE rifa_boletas SET anulada = TRUE, anulada_en = NOW(), anulada_motivo = $3
         WHERE sede = $1 AND regexp_replace(factura, '\\D', '', 'g') = $2 AND NOT anulada RETURNING numero`,
        [sede, numDig, motivo]
    );
    for (const r of rows) {
        await client.query(`INSERT INTO rifa_eventos (numero, accion, detalle, actor) VALUES ($1, 'boleta_anulada', $2, 'integracion_alegra')`, [r.numero, motivo]);
    }
    return rows.length;
}

async function procesarFactura(client, sede, f, res) {
    const numDig = digitos(f.numero);
    if (!numDig) { res.ignoradas.push({ numero: f.numero, motivo: 'sin número' }); return; }
    const cli = f.cliente || {};
    const total = Number(f.total) || 0;
    const saldo = Number(f.saldo) || 0;
    const estado = String(f.estado || '').toLowerCase();

    await client.query(
        `INSERT INTO rifa_facturas (sede, numero_digitos, numero, id_alegra, fecha, total, saldo, estado, cliente)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (sede, numero_digitos) DO UPDATE SET numero = EXCLUDED.numero, id_alegra = EXCLUDED.id_alegra,
             fecha = EXCLUDED.fecha, total = EXCLUDED.total, saldo = EXCLUDED.saldo, estado = EXCLUDED.estado,
             cliente = EXCLUDED.cliente, actualizado_en = NOW()`,
        [sede, numDig, String(f.numero), f.id_alegra ? String(f.id_alegra) : null, f.fecha || null, total, saldo, estado, cli]
    );
    const resultado = async (r) => client.query('UPDATE rifa_facturas SET resultado = $3 WHERE sede = $1 AND numero_digitos = $2', [sede, numDig, r]);

    if (estado === 'void' || estado === 'anulada') {
        const n = await anularFactura(client, sede, numDig, 'Factura anulada en Alegra');
        if (n) res.anuladas += n;
        await resultado('anulada');
        return;
    }
    if (!f.fecha || f.fecha < DESDE || f.fecha > HASTA) { await resultado('fuera_de_fechas'); res.ignoradas.push({ numero: f.numero, motivo: 'fuera de fechas' }); return; }
    if (saldo > 0) { await resultado('pendiente_pago'); res.pendientes_pago += 1; return; }

    const cantidad = Math.floor((total - saldo) / VALOR_BOLETA);
    if (cantidad < 1) { await resultado('menor_100000'); return; }

    const nombre = limpiarNombre(cli.nombre);
    const cedula = fmtCedula(cli.identificacion);
    const celular = normCelular(cli.celular);
    const correo = cli.correo ? String(cli.correo).trim() : null;

    const { rows: existentes } = await client.query(
        `SELECT numero, boleta_de_factura, celular, envio_estado, anulada FROM rifa_boletas
         WHERE sede = $1 AND regexp_replace(factura, '\\D', '', 'g') = $2 ORDER BY boleta_de_factura`,
        [sede, numDig]
    );
    if (existentes.some((b) => b.anulada)) { await resultado('anulada'); return; }

    // Actualización de celular en boletas existentes que aún no se han enviado.
    if (celular) {
        for (const b of existentes) {
            const actual = digitos(b.celular);
            if (actual !== celular && b.envio_estado === 'pendiente') {
                const { rows: [d] } = await client.query('SELECT * FROM rifa_boletas WHERE numero = $1', [b.numero]);
                const img = await generarBoleta({ ...d, celular: fmtCelular(celular) });
                const [canal, motivo] = await canalPara(client, celular);
                await client.query(
                    `UPDATE rifa_boletas SET celular = $2, imagen = $3, imagen_sha256 = $4, canal_envio = $5, canal_motivo = $6,
                         revision_estado = 'pendiente', revisado_por = NULL, revisado_en = NULL, corte = $7
                     WHERE numero = $1`,
                    [b.numero, fmtCelular(celular), img, crypto.createHash('sha256').update(img).digest('hex'), canal, motivo, corteDe()]
                );
                await client.query(`INSERT INTO rifa_eventos (numero, accion, detalle, actor) VALUES ($1, 'celular_actualizado', $2, 'integracion_alegra')`,
                    [b.numero, `${b.celular || '(vacío)'} → ${fmtCelular(celular)}; vuelve a revisión`]);
                res.actualizadas += 1;
            }
        }
    }

    // Boletas nuevas que falten para esta factura.
    const faltan = cantidad - existentes.length;
    if (faltan < 0) {
        await resultado('mas_boletas_que_monto');
        res.alertas.push(`${sede} ${f.numero}: tiene ${existentes.length} boletas pero el monto pagado da ${cantidad}. Revisar a mano.`);
        return;
    }
    if (faltan > 0) {
        const [canal, motivo] = await canalPara(client, celular);
        const obs = await observaciones({ nombre, cedula });
        const corte = corteDe();
        for (let k = existentes.length + 1; k <= cantidad; k += 1) {
            const { rows: [{ siguiente }] } = await client.query('SELECT COALESCE(MAX(numero), 0) + 1 AS siguiente FROM rifa_boletas');
            const datos = { numero: siguiente, factura: String(f.numero), nombre, cedula, celular: fmtCelular(celular), sede };
            const img = await generarBoleta(datos);
            await client.query(
                `INSERT INTO rifa_boletas (numero, factura, boleta_de_factura, fecha_factura, sede, nombre, cedula, celular, correo,
                     imagen, imagen_sha256, observacion_auditoria, canal_envio, canal_motivo, origen, corte)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'alegra', $15)`,
                [siguiente, String(f.numero), k, f.fecha, sede, nombre, cedula, fmtCelular(celular) || null, correo,
                    img, crypto.createHash('sha256').update(img).digest('hex'), obs, canal, motivo, corte]
            );
            await client.query(`INSERT INTO rifa_eventos (numero, accion, detalle, actor) VALUES ($1, 'boleta_creada', $2, 'integracion_alegra')`,
                [siguiente, `Factura ${sede} ${f.numero} ($${total.toLocaleString('es-CO')}), corte ${corte.toISOString()}`]);
            res.nuevas.push(siguiente);
        }
    }
    await resultado(existentes.length ? 'ya_registrada' : 'boletas_creadas');
}

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

// Secreto compartido con n8n (se ve en /revisionboletas → Envío). Se crea al primer uso.
async function secretoValido(req) {
    const { rows: [s] } = await pool.query(`SELECT valor FROM rifa_config WHERE clave = 'integracion_secret'`);
    const recibido = String(req.get('X-Integracion-Secret') || '');
    return !!s && recibido.length === s.valor.length && crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(s.valor));
}

// POST /correo-prueba — envía el correo de boletas de prueba SIEMPRE a
// comercial@ (sirve para verificar el correo saliente desde n8n o soporte).
router.post('/correo-prueba', async (req, res) => {
    if (!(await secretoValido(req))) return res.status(401).json({ success: false });
    const { enviarACliente, primerClienteParaPrueba, correoValido } = require('./rifaCorreo');
    const cliente = await primerClienteParaPrueba();
    if (!cliente) return res.status(404).json({ success: false, error: 'No hay clientes con correo' });
    const destinoPrueba = req.body?.destino ? String(req.body.destino).trim() : null;
    if (destinoPrueba && !correoValido(destinoPrueba)) return res.status(400).json({ success: false, error: 'Correo inválido' });
    const r = await enviarACliente(cliente, { prueba: true, actor: 'prueba_integracion', destinoPrueba });
    return res.json({ success: r.estado === 'enviado', resultado: r });
});

router.post('/facturas', async (req, res) => {
    if (!(await secretoValido(req))) return res.status(401).json({ success: false });
    const sede = SEDES[String(req.body?.sede || '').trim().toLowerCase()];
    if (!sede) return res.status(400).json({ success: false, error: 'sede inválida (Viva, Aranjuez o Buenavista)' });
    const facturas = Array.isArray(req.body?.facturas) ? req.body.facturas.slice(0, 500) : [];
    const notas = Array.isArray(req.body?.notas_credito) ? req.body.notas_credito.slice(0, 500) : [];

    const resumen = { sede, recibidas: facturas.length, nuevas: [], actualizadas: 0, anuladas: 0, pendientes_pago: 0, ignoradas: [], alertas: [] };
    const client = await pool.connect();
    try {
        // Un solo proceso a la vez asigna números (evita números repetidos).
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(4242001)');
        for (const f of facturas) await procesarFactura(client, sede, f, resumen);
        for (const nc of notas) {
            const n = await anularFactura(client, sede, digitos(nc.factura_numero), `Nota crédito ${nc.numero || ''} en Alegra`.trim());
            resumen.anuladas += n;
        }
        await client.query('COMMIT');
        return res.json({ success: true, ...resumen });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[rifa-integracion] facturas:', err);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
