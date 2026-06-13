// Alternativa local sin Docker: levanta un PostgreSQL embebido (descarga binarios la primera vez),
// crea la base de datos "polla_db" y carga backend/db/schema.sql.
// Uso: node scripts/start-db.js

const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const EmbeddedPostgres = require('embedded-postgres').default;

const DATA_DIR = path.join(__dirname, '..', 'db', 'pgdata');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

const PORT = 5432;
const USER = 'polla_user';
const PASSWORD = 'polla_pass';
const DB_NAME = 'polla_db';

async function main() {
    const yaExistia = fs.existsSync(DATA_DIR) && fs.readdirSync(DATA_DIR).length > 0;

    const pg = new EmbeddedPostgres({
        databaseDir: DATA_DIR,
        user: USER,
        password: PASSWORD,
        port: PORT,
        persistent: true,
    });

    if (!yaExistia) {
        console.log('Inicializando base de datos PostgreSQL embebida (puede descargar binarios la primera vez)...');
        await pg.initialise();
    }

    console.log('Iniciando PostgreSQL en el puerto', PORT, '...');
    await pg.start();

    if (!yaExistia) {
        console.log(`Creando base de datos "${DB_NAME}"...`);
        await pg.createDatabase(DB_NAME);

        console.log('Cargando schema.sql...');
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        const client = new Client({
            host: 'localhost',
            port: PORT,
            user: USER,
            password: PASSWORD,
            database: DB_NAME,
        });
        await client.connect();
        await client.query(schema);
        await client.end();
        console.log('Schema cargado correctamente.');
    }

    console.log('');
    console.log('PostgreSQL listo y corriendo en segundo plano.');
    console.log(`DATABASE_URL=postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`);
    console.log('');
    console.log('Presiona Ctrl+C para detener la base de datos.');

    process.on('SIGINT', async () => {
        console.log('\nDeteniendo PostgreSQL...');
        await pg.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Error iniciando la base de datos embebida:', err);
    process.exit(1);
});
