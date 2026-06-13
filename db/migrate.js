require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function migrar() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    await pool.query(sql);
    console.log('Esquema aplicado correctamente.');
    await pool.end();
}

migrar().catch((err) => {
    console.error('Error aplicando el esquema:', err);
    process.exit(1);
});
