const { Pool } = require('pg');

// Si DB_CA_CERT está definido (contenido PEM del certificado CA de la base de
// datos), se valida el certificado del servidor (rejectUnauthorized: true).
// Si no, se usa rejectUnauthorized: false (cifrado pero sin validar el emisor)
// como hasta ahora, para no romper el despliegue mientras se configura el CA.
function sslConfig() {
    if (process.env.DB_SSL !== 'true') return false;
    if (process.env.DB_CA_CERT) {
        return { ca: process.env.DB_CA_CERT, rejectUnauthorized: true };
    }
    return { rejectUnauthorized: false };
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig(),
    max: Number(process.env.DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('Error inesperado en el pool de Postgres:', err.message);
});

module.exports = pool;
