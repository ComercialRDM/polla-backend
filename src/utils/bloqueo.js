const pool = require('../db');

// Claves de bloqueo exclusivo (advisory locks de Postgres). 4242001 ya la usa
// la integración con Alegra para asignar números de boleta.
const BLOQUEOS = {
    ENVIO_WHATSAPP: 4242101,
    ENVIO_CORREO: 4242102,
};

// Ejecuta `fn` solo si nadie más tiene la clave, en cualquier instancia del
// backend. No espera: si está ocupada devuelve { ocupado: true } sin ejecutar.
// El bloqueo vive en una conexión dedicada y se libera al terminar (o si la
// conexión se cae).
async function conBloqueo(clave, fn) {
    const client = await pool.connect();
    try {
        const { rows: [{ ok }] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [clave]);
        if (!ok) return { ocupado: true };
        try {
            return { ocupado: false, valor: await fn() };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [clave]);
        }
    } finally {
        client.release();
    }
}

module.exports = { BLOQUEOS, conBloqueo };
