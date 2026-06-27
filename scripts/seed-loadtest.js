/**
 * seed-loadtest.js
 * Prepara datos de prueba para la simulación de carga con k6: usuarios +
 * transacciones APROBADAS (para hammerear /api/polla/votar) y transacciones
 * PENDIENTES (para hammerear /api/webhooks/wompi). Todo marcado es_test=TRUE
 * y con metodo='DEMO', así que nunca pasa por aprobacionService.js — no se
 * envía ningún correo ni WhatsApp real al crear estos datos.
 *
 * Uso (contra la BD local, nunca contra producción):
 *   node scripts/seed-loadtest.js
 *   LOADTEST_APROBADOS=20000 LOADTEST_PENDIENTES=2000 node scripts/seed-loadtest.js
 *
 * Escribe loadtest/data/tokens.json y loadtest/data/pendientes.json para que
 * los scripts de k6 los lean con open().
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const APROBADOS = Number(process.env.LOADTEST_APROBADOS) || 20000;
const PENDIENTES = Number(process.env.LOADTEST_PENDIENTES) || 2000;
const VALOR_PAGADO = 10000;
const LOTE = 500;

const DATA_DIR = path.join(__dirname, '..', 'loadtest', 'data');

const isRender = (process.env.DATABASE_URL || '').includes('render.com');
if (isRender) {
    console.error('❌ DATABASE_URL parece ser de producción (Render). Este script es solo para la BD local de pruebas. Abortando.');
    process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function obtenerOCrearPartidoDePrueba(client) {
    const { rows } = await client.query(
        `SELECT id FROM partidos WHERE equipo_local = 'LoadTest A' AND equipo_visitante = 'LoadTest B' LIMIT 1`
    );
    if (rows.length > 0) return rows[0].id;

    const { rows: nuevo } = await client.query(
        `INSERT INTO partidos (equipo_local, equipo_visitante, fecha_hora_inicio, estado, fase)
         VALUES ('LoadTest A', 'LoadTest B', now() + interval '1 day', 'activo', 'grupos')
         RETURNING id`
    );
    return nuevo[0].id;
}

async function seedAprobados(client, partidoId, cantidad) {
    const tokens = [];
    for (let inicio = 0; inicio < cantidad; inicio += LOTE) {
        const fin = Math.min(inicio + LOTE, cantidad);
        const valores = [];
        const params = [];
        for (let i = inicio; i < fin; i++) {
            const celular = `3${String(900000000 + i).padStart(9, '0')}`;
            const correo = `loadtest+aprobado${i}@example.com`;
            const nombre = `LoadTest Aprobado ${i}`;
            params.push(nombre, celular, correo);
            const base = params.length - 3;
            valores.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
        }
        const { rows: usuarios } = await client.query(
            `INSERT INTO usuarios (nombre, celular, correo) VALUES ${valores.join(',')}
             ON CONFLICT (celular) DO UPDATE SET nombre = EXCLUDED.nombre
             RETURNING id`,
            params
        );

        const valoresTx = [];
        const paramsTx = [];
        usuarios.forEach((u) => {
            paramsTx.push(u.id, partidoId, VALOR_PAGADO, VALOR_PAGADO, 10);
            const base = paramsTx.length - 5;
            valoresTx.push(`($${base + 1}, $${base + 2}, 'DEMO', $${base + 3}, $${base + 4}, $${base + 5}, 'APROBADO', TRUE)`);
        });
        const { rows: transacciones } = await client.query(
            `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, es_test)
             VALUES ${valoresTx.join(',')}
             RETURNING token_acceso`,
            paramsTx
        );

        transacciones.forEach((t) => tokens.push({ token_acceso: t.token_acceso, partido_id: partidoId }));
        console.log(`  aprobados: ${fin}/${cantidad}`);
    }
    return tokens;
}

async function seedPendientes(client, partidoId, cantidad) {
    const pendientes = [];
    for (let inicio = 0; inicio < cantidad; inicio += LOTE) {
        const fin = Math.min(inicio + LOTE, cantidad);
        const valores = [];
        const params = [];
        for (let i = inicio; i < fin; i++) {
            const celular = `3${String(800000000 + i).padStart(9, '0')}`;
            const correo = `loadtest+pendiente${i}@example.com`;
            const nombre = `LoadTest Pendiente ${i}`;
            params.push(nombre, celular, correo);
            const base = params.length - 3;
            valores.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
        }
        const { rows: usuarios } = await client.query(
            `INSERT INTO usuarios (nombre, celular, correo) VALUES ${valores.join(',')}
             ON CONFLICT (celular) DO UPDATE SET nombre = EXCLUDED.nombre
             RETURNING id`,
            params
        );

        const valoresTx = [];
        const paramsTx = [];
        usuarios.forEach((u, idx) => {
            const reference = `LOADTEST-${inicio + idx}-${Date.now()}`;
            paramsTx.push(u.id, partidoId, VALOR_PAGADO, VALOR_PAGADO, 10, reference);
            const base = paramsTx.length - 6;
            valoresTx.push(`($${base + 1}, $${base + 2}, 'Wompi', $${base + 3}, $${base + 4}, $${base + 5}, 'PENDIENTE', TRUE, $${base + 6})`);
        });
        const { rows: transacciones } = await client.query(
            `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, es_test, reference)
             VALUES ${valoresTx.join(',')}
             RETURNING id, reference, valor_pagado`,
            paramsTx
        );

        transacciones.forEach((t) => pendientes.push({
            transaccion_id: t.id,
            reference: t.reference,
            amount_in_cents: t.valor_pagado * 100,
        }));
        console.log(`  pendientes: ${fin}/${cantidad}`);
    }
    return pendientes;
}

async function run() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const client = await pool.connect();
    try {
        const partidoId = await obtenerOCrearPartidoDePrueba(client);
        console.log(`⚽ Partido de prueba id=${partidoId}`);

        console.log(`Creando ${APROBADOS} transacciones APROBADAS (para /votar)...`);
        const tokens = await seedAprobados(client, partidoId, APROBADOS);
        fs.writeFileSync(path.join(DATA_DIR, 'tokens.json'), JSON.stringify(tokens));
        console.log(`✅ ${tokens.length} tokens escritos en loadtest/data/tokens.json`);

        console.log(`Creando ${PENDIENTES} transacciones PENDIENTES (para ráfaga de webhook)...`);
        const pendientes = await seedPendientes(client, partidoId, PENDIENTES);
        fs.writeFileSync(path.join(DATA_DIR, 'pendientes.json'), JSON.stringify(pendientes));
        console.log(`✅ ${pendientes.length} pendientes escritos en loadtest/data/pendientes.json`);
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch((err) => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
