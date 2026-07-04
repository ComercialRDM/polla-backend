/**
 * CORRECCIÓN DE EMERGENCIA: Colombia vs Ghana
 *
 * El resultado fue publicado como 2-0 (incorrecto).
 * El resultado real verificado (FIFA, ESPN, BBC, Sky Sports) fue 1-0 (gol de Jhon Arias, min. 14).
 *
 * Este script:
 *   1. Encuentra el partido Colombia vs Ghana en la BD
 *   2. Elimina los bonos_colombia incorrectos asignados por el marcador 2-0 (no reclamados)
 *   3. Actualiza el marcador a 1-0
 *   4. Re-asigna bonos_colombia a los acertantes del marcador 1-0
 *   5. Registra la corrección en la tabla de auditoría resultado_verificacion
 *
 * Ejecutar en Render Shell:
 *   node src/scripts/corregirColombiaGhana.js
 */

require('dotenv').config();
const pool = require('../db');
const { crearTablaAuditoria, registrarVerificacion } = require('../services/verificacionResultados');
const crypto = require('crypto');

// Fisher-Yates shuffle seguro — mismo algoritmo que en admin.js
function shuffleSeguro(arr) {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

const GOLES_LOCAL_CORRECTO = 1;
const GOLES_VISITANTE_CORRECTO = 0;

async function corregir() {
    await crearTablaAuditoria();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Buscar el partido
        const { rows: partidos } = await client.query(
            `SELECT * FROM partidos
             WHERE LOWER(equipo_local) = 'colombia'
               AND LOWER(equipo_visitante) = 'ghana'
               AND estado = 'cerrado'
             LIMIT 1`
        );

        if (partidos.length === 0) {
            console.error('❌ No se encontró el partido Colombia vs Ghana con estado=cerrado. Verifica los nombres exactos en la BD.');
            await client.query('ROLLBACK');
            return;
        }

        const partido = partidos[0];
        console.log(`✔ Partido encontrado: #${partido.id} — ${partido.equipo_local} ${partido.goles_local}-${partido.goles_visitante} ${partido.equipo_visitante} (${partido.fase})`);

        if (partido.goles_local === GOLES_LOCAL_CORRECTO && partido.goles_visitante === GOLES_VISITANTE_CORRECTO) {
            console.log('✔ El marcador ya está correcto (1-0). No se necesita corrección.');
            await client.query('ROLLBACK');
            return;
        }

        // 2. Revisar bonos existentes (asignados con el marcador incorrecto)
        const { rows: bonos } = await client.query(
            `SELECT bc.id, bc.usuario_id, bc.monto_cop, bc.reclamado, u.nombre, u.correo
             FROM bonos_colombia bc
             JOIN usuarios u ON u.id = bc.usuario_id
             WHERE bc.partido_id = $1`,
            [partido.id]
        );

        const bonosReclamados = bonos.filter((b) => b.reclamado);
        const bonosNoReclamados = bonos.filter((b) => !b.reclamado);

        if (bonosReclamados.length > 0) {
            console.warn(`⚠ ATENCIÓN: ${bonosReclamados.length} bono(s) YA RECLAMADOS con el marcador incorrecto (${partido.goles_local}-${partido.goles_visitante}):`);
            bonosReclamados.forEach((b) => console.warn(`   - ${b.nombre} (${b.correo}) — $${b.monto_cop.toLocaleString()}`));
            console.warn('   Estos bonos NO serán eliminados y requieren gestión manual (contactar al ganador).');
        }

        if (bonosNoReclamados.length > 0) {
            console.log(`🗑 Eliminando ${bonosNoReclamados.length} bono(s) no reclamados asignados con marcador incorrecto...`);
            bonosNoReclamados.forEach((b) => console.log(`   - ${b.nombre} (${b.correo}) — $${b.monto_cop.toLocaleString()}`));
            await client.query(
                `DELETE FROM bonos_colombia WHERE partido_id = $1 AND reclamado = FALSE`,
                [partido.id]
            );
        }

        // 3. Actualizar marcador
        await client.query(
            'UPDATE partidos SET goles_local = $1, goles_visitante = $2 WHERE id = $3',
            [GOLES_LOCAL_CORRECTO, GOLES_VISITANTE_CORRECTO, partido.id]
        );
        console.log(`✔ Marcador actualizado a ${GOLES_LOCAL_CORRECTO}-${GOLES_VISITANTE_CORRECTO}`);

        // 4. Re-asignar Bono Colombia a acertantes del 1-0
        const { rows: acertantes } = await client.query(
            `SELECT pr.usuario_id, u.nombre, u.correo, u.celular
             FROM pronosticos pr
             JOIN usuarios u ON u.id = pr.usuario_id
             LEFT JOIN transacciones t ON t.id = pr.transaccion_id
             WHERE pr.partido_id = $1
               AND pr.goles_local = $2
               AND pr.goles_visitante = $3
               AND COALESCE(t.es_test, FALSE) = FALSE
               AND COALESCE(t.es_especial, FALSE) = FALSE`,
            [partido.id, GOLES_LOCAL_CORRECTO, GOLES_VISITANTE_CORRECTO]
        );

        let bonoColombia;
        if (acertantes.length > 0) {
            const sorteoRealizado = acertantes.length > 10;
            const ganadores = sorteoRealizado ? shuffleSeguro(acertantes).slice(0, 10) : acertantes;
            const montoPorGanador = sorteoRealizado ? 100000 : Math.floor(1000000 / acertantes.length);

            console.log(`🏆 Bono Colombia: ${acertantes.length} acertantes del 1-0${sorteoRealizado ? ' (sorteo realizado entre todos)' : ''}. $${montoPorGanador.toLocaleString()} por ganador.`);
            for (const g of ganadores) {
                await client.query(
                    `INSERT INTO bonos_colombia (partido_id, usuario_id, monto_cop)
                     VALUES ($1, $2, $3) ON CONFLICT (partido_id, usuario_id) DO NOTHING`,
                    [partido.id, g.usuario_id, montoPorGanador]
                );
                console.log(`   + ${g.nombre} (${g.correo || g.celular}) — $${montoPorGanador.toLocaleString()}`);
            }
            bonoColombia = { ganadores: ganadores.map((g) => g.nombre), montoPorGanador };
        } else {
            console.log('ℹ Nadie acertó el marcador 1-0 — Bono Colombia desierto.');
            bonoColombia = { desierto: true };
        }

        await client.query('COMMIT');
        console.log('✔ Transacción completada.');

        // 5. Auditoría
        await registrarVerificacion({
            partido_id: partido.id,
            goles_local: GOLES_LOCAL_CORRECTO,
            goles_visitante: GOLES_VISITANTE_CORRECTO,
            fuentes: [
                { fuente: 'FIFA.com', goles_local: 1, goles_visitante: 0 },
                { fuente: 'ESPN',     goles_local: 1, goles_visitante: 0 },
                { fuente: 'BBC Sport', goles_local: 1, goles_visitante: 0 },
                { fuente: 'Sky Sports', goles_local: 1, goles_visitante: 0 },
            ],
            consenso: true,
            alertar: false,
            accion: 'script_correccion_colombia_ghana',
            admin_id: null,
        });

        console.log('\n=== RESUMEN ===');
        console.log(`Partido:          Colombia vs Ghana (#${partido.id})`);
        console.log(`Marcador anterior: ${partido.goles_local}-${partido.goles_visitante} (incorrecto)`);
        console.log(`Marcador correcto: ${GOLES_LOCAL_CORRECTO}-${GOLES_VISITANTE_CORRECTO}`);
        console.log(`Bonos eliminados: ${bonosNoReclamados.length} (no reclamados)`);
        console.log(`Bonos reclamados NO corregidos: ${bonosReclamados.length} (requieren gestión manual)`);
        console.log(`Bono Colombia nuevo:`, JSON.stringify(bonoColombia));
        console.log('\n✅ Los puntos de todos los usuarios se actualizan automáticamente desde ya (cálculo dinámico).');
        if (bonosReclamados.length > 0) {
            console.log('⚠ Recuerda contactar manualmente a los ganadores incorrectos para gestionar sus bonos reclamados.');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error durante la corrección:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

corregir();
