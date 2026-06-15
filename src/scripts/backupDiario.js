require('dotenv').config();
const zlib = require('zlib');
const pool = require('../db');
const { enviarCorreoBackup } = require('../services/emailService');

// Tablas a respaldar, en orden seguro para una futura restauración
// (sin dependencias circulares: padres antes que hijos).
const TABLAS = [
    'usuarios',
    'admin_usuarios',
    'local_usuarios',
    'partidos',
    'transacciones',
    'pronosticos',
    'manychat_metricas_diarias',
];

async function generarBackup() {
    const datos = {};
    const resumen = {};

    for (const tabla of TABLAS) {
        const { rows } = await pool.query(`SELECT * FROM ${tabla}`);
        datos[tabla] = rows;
        resumen[tabla] = rows.length;
    }

    const json = JSON.stringify({ generadoEn: new Date().toISOString(), datos }, null, 2);
    const buffer = await new Promise((resolve, reject) => {
        zlib.gzip(json, (err, result) => (err ? reject(err) : resolve(result)));
    });

    return { buffer, resumen };
}

async function main() {
    const { buffer, resumen } = await generarBackup();

    const fecha = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-polla-${fecha}.json.gz`;
    const destinatario = process.env.ADMIN_EMAIL || process.env.SMTP_USER;

    await enviarCorreoBackup({ destinatario, filename, buffer, resumen });

    console.log('Backup enviado a', destinatario, '-', JSON.stringify(resumen));
}

main()
    .catch((err) => {
        console.error('Error generando/enviando el backup:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
