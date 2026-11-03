/**
 * Regenera con el diseño de Navidad las boletas de la rifa cuya factura es del
 * 1-nov-2026 en adelante y que todavía no le han llegado al cliente por ningún
 * canal (WhatsApp y correo pendientes o fallidos). No cambia número, datos,
 * aprobación ni corte: solo la imagen.
 *
 * Uso: DB_SSL=true node scripts/regenerar-boletas-navidad.js            (solo lista)
 *      DB_SSL=true node scripts/regenerar-boletas-navidad.js --aplicar  (escribe)
 */
const crypto = require('crypto');
const pool = require('../src/db');
const { generarBoleta, disenoPara } = require('../src/services/rifaBoletaImagen');

const APLICAR = process.argv.includes('--aplicar');

async function main() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT * FROM rifa_boletas
             WHERE fecha_factura >= '2026-11-01' AND NOT anulada
               AND envio_estado IN ('pendiente', 'fallido') AND correo_estado IN ('pendiente', 'fallido')
             ORDER BY numero`
        );
        console.log(`${rows.length} boletas de noviembre sin enviar${APLICAR ? '' : ' (solo lista; usa --aplicar para escribir)'}`);
        for (const b of rows) {
            const diseno = disenoPara(b.fecha_factura);
            console.log(`  ${b.numero}  ${b.sede}  ${b.factura}  ${b.revision_estado}  -> ${diseno}`);
            if (!APLICAR || diseno !== 'navidad') continue;
            const img = await generarBoleta(b);
            await client.query('BEGIN');
            await client.query(
                // Se vuelve a comprobar el estado para no tocar una boleta que se envió mientras tanto.
                `UPDATE rifa_boletas SET imagen = $2, imagen_sha256 = $3
                 WHERE numero = $1 AND envio_estado IN ('pendiente', 'fallido') AND correo_estado IN ('pendiente', 'fallido')`,
                [b.numero, img, crypto.createHash('sha256').update(img).digest('hex')]
            );
            await client.query(`INSERT INTO rifa_eventos (numero, accion, detalle, actor) VALUES ($1, 'imagen_regenerada', $2, 'script_navidad')`,
                [b.numero, 'Imagen regenerada con el diseño de Navidad (factura de noviembre)']);
            await client.query('COMMIT');
        }
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
