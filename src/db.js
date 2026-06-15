const { Pool } = require('pg');

// Si DB_CA_CERT está definido (contenido PEM del certificado CA de la base de
// datos), se valida el certificado del servidor con ese CA.
// Si DB_SSL_STRICT=true (sin DB_CA_CERT), se valida contra las CAs públicas
// que trae Node por defecto (Render firma sus certificados de Postgres con
// una CA pública reconocida).
// Si ninguna está definida, se usa rejectUnauthorized: false (cifrado pero sin
// validar el emisor) como hasta ahora, para no romper el despliegue.
function sslConfig() {
    if (process.env.DB_SSL !== 'true') {
        console.warn('DB_SSL no está en "true": la conexión a Postgres no usará TLS. Verifica esta variable en producción.');
        return false;
    }
    if (process.env.DB_CA_CERT) {
        return { ca: process.env.DB_CA_CERT, rejectUnauthorized: true };
    }
    if (process.env.DB_SSL_STRICT === 'true') {
        return { rejectUnauthorized: true };
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
