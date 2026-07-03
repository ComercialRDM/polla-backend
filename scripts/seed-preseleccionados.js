/**
 * Seed de influencers pre-seleccionados (ejecutar una sola vez).
 * Uso: node scripts/seed-preseleccionados.js
 *
 * Idempotente: si el nombre ya existe en influencers_preseleccionados lo omite.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../src/db');
const crypto = require('crypto');

const INFLUENCERS = [
    {
        nombre_completo: 'Nicole Ravachi',
        email: 'nr@nicoleravachi.com',
        celular: null,
        seguidores: 496301,        // IG 192.8K + TT 303.5K
        tasa_engagement: 2.64,     // IG engagement rate
        red_social: 'ambas',
        notas: 'IG @nicoleravachi 192.8K seg, 2.64% ER, ~158.7K views | TT @nicoleravachi 303.5K seg, ~61K views promedio',
    },
    {
        nombre_completo: 'Nicole Skafi Jaar',
        email: 'nicoleskafijaar@gmail.com',
        celular: null,
        seguidores: 58965,         // IG 53K + TT 5.965K
        tasa_engagement: null,     // solo views disponibles
        red_social: 'ambas',
        notas: 'IG @nicolesjaar 53K seg, ~11.1K views | TT @nicoleskafijaar_ 5.965K seg, ~2.25K views',
    },
    {
        nombre_completo: 'Daniella Donado Visbal',
        email: null,
        celular: null,
        seguidores: 1705800,       // IG 1.367M + TT 338.5K
        tasa_engagement: 0.26,     // IG engagement rate
        red_social: 'ambas',
        notas: 'IG @danidonado 1.367M seg, 0.26% ER, ~245K views | TT @danidonado 338.5K seg, ~22.3K views',
    },
    {
        nombre_completo: 'Daniela Vergel',
        email: 'pautasdanielavergelc@gmail.com',
        celular: null,
        seguidores: 189498,        // IG 36.3K + TT 153.2K
        tasa_engagement: 4.01,     // promedio IG 5.81% + TT 2.2%
        red_social: 'ambas',
        notas: 'IG @danielavergelc 36.3K seg, 5.81% ER, ~55.7K views | TT @danielavergelc 153.2K seg, 2.2% ER, ~30.7K views',
    },
    {
        nombre_completo: 'Aithana Del Gallego',
        email: null,
        celular: null,
        seguidores: 353363,        // IG 29.4K + TT 324K
        tasa_engagement: 6.51,     // promedio IG 10.85% + TT 2.17%
        red_social: 'ambas',
        notas: 'IG @aithanadelgallego 29.4K seg, 10.85% ER, ~37.6K views | TT @aithanadelgallego 324K seg, 2.17% ER, ~87.8K views',
    },
    {
        nombre_completo: 'Maria Carolina Donado',
        email: null,
        celular: null,
        seguidores: 170204,        // IG 152.7K + TT 17.5K
        tasa_engagement: 3.17,     // IG engagement rate
        red_social: 'ambas',
        notas: 'IG @maricadonadov 152.7K seg, 3.17% ER, ~55.3K views | TT @maricadonadov 17.5K seg, ~6.35K views',
    },
];

function normalizarBase(nombre) {
    return String(nombre)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'inf';
}

async function generarCodigoAfiliado(client, nombre) {
    const base = normalizarBase(nombre);
    for (let i = 0; i < 20; i++) {
        const candidato = `${base}${Math.floor(100 + Math.random() * 900)}`;
        const { rows } = await client.query(
            `SELECT 1 FROM influencers WHERE codigo_afiliado = $1
             UNION SELECT 1 FROM influencers_preseleccionados WHERE codigo_afiliado = $1`,
            [candidato]
        );
        if (rows.length === 0) return candidato;
    }
    throw new Error(`No se pudo generar código único para ${nombre}`);
}

async function main() {
    const client = await pool.connect();
    try {
        // Buscar partido activo
        const { rows: partidos } = await client.query(
            `SELECT id, equipo_local, equipo_visitante FROM partidos WHERE estado = 'activo' ORDER BY fecha_hora_inicio ASC LIMIT 1`
        );
        if (partidos.length === 0) {
            console.error('No hay partidos activos. Crea uno primero desde el admin.');
            process.exit(1);
        }
        const partido = partidos[0];
        console.log(`Usando partido: ${partido.equipo_local} vs ${partido.equipo_visitante} (id=${partido.id})\n`);

        for (const inf of INFLUENCERS) {
            await client.query('BEGIN');
            try {
                // Verificar si ya existe
                const { rows: existe } = await client.query(
                    'SELECT id FROM influencers_preseleccionados WHERE nombre_completo = $1',
                    [inf.nombre_completo]
                );
                if (existe.length > 0) {
                    console.log(`⏭️  ${inf.nombre_completo} ya existe (id=${existe[0].id}), omitiendo.`);
                    await client.query('ROLLBACK');
                    continue;
                }

                // Buscar o crear usuario
                // celular es NOT NULL en usuarios; si no tienen número usamos
                // un placeholder interno único (no se usa para auth ni SMS).
                const celularFinal = inf.celular
                    || ('P' + String(Date.now()).slice(-9)); // 10 chars max, unico

                let usuario;
                if (inf.email) {
                    const { rows: ex } = await client.query(
                        'SELECT * FROM usuarios WHERE correo = $1',
                        [inf.email]
                    );
                    usuario = ex[0];
                }
                if (!usuario) {
                    const { rows } = await client.query(
                        'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
                        [inf.nombre_completo, inf.email, celularFinal]
                    );
                    usuario = rows[0];
                    console.log(`   ✅ Usuario creado id=${usuario.id}`);
                } else {
                    console.log(`   ♻️  Usuario existente id=${usuario.id}`);
                }

                // Crear transacción especial
                const { rows: transRows } = await client.query(
                    `INSERT INTO transacciones
                     (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, es_especial)
                     VALUES ($1, $2, 'Especial', 500000, 500000, 30, 'APROBADO', TRUE)
                     RETURNING token_acceso, id`,
                    [usuario.id, partido.id]
                );
                const trans = transRows[0];

                const codigo_afiliado = await generarCodigoAfiliado(client, inf.nombre_completo);
                const token_invitacion = crypto.randomBytes(16).toString('hex');

                const { rows: presRows } = await client.query(
                    `INSERT INTO influencers_preseleccionados
                     (nombre_completo, celular, email, seguidores, tasa_engagement, red_social, notas,
                      token_invitacion, usuario_id, token_acceso, codigo_afiliado)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                     RETURNING id, token_invitacion, codigo_afiliado`,
                    [inf.nombre_completo, inf.celular, inf.email, inf.seguidores,
                     inf.tasa_engagement, inf.red_social, inf.notas,
                     token_invitacion, usuario.id, trans.token_acceso, codigo_afiliado]
                );

                await client.query('COMMIT');
                const p = presRows[0];
                console.log(`✅ ${inf.nombre_completo}`);
                console.log(`   Link invitación : ${process.env.FRONTEND_URL || 'https://pollaret.com'}/invitacion/${p.token_invitacion}`);
                console.log(`   Link referido   : ${process.env.FRONTEND_URL || 'https://pollaret.com'}/?aff=${p.codigo_afiliado}`);
                console.log();
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`❌ Error en ${inf.nombre_completo}: ${err.message}`);
            }
        }

        console.log('Seed completado.');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
