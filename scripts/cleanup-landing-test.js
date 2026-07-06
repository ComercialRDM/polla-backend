/**
 * Limpia los registros de prueba del número 3012786234 (Diego)
 * generados por /api/polla/pronostico-landing.
 * Uso: node scripts/cleanup-landing-test.js
 */
const pool = require('../src/db');

const CELULAR_TEST = '3012786234';

async function cleanup() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT id, nombre FROM usuarios WHERE celular = $1',
            [CELULAR_TEST]
        );

        if (rows.length === 0) {
            console.log(`No se encontró usuario con celular ${CELULAR_TEST}`);
            await client.query('ROLLBACK');
            return;
        }

        const uid = rows[0].id;
        console.log(`Usuario encontrado: ${rows[0].nombre} (id=${uid})`);

        // 1. Borrar pronósticos de transacciones Landing
        const del1 = await client.query(
            `DELETE FROM pronosticos
             WHERE transaccion_id IN (
                 SELECT id FROM transacciones
                 WHERE usuario_id = $1 AND metodo = 'Landing'
             )`,
            [uid]
        );
        console.log(`Pronósticos borrados: ${del1.rowCount}`);

        // 2. Borrar transacciones Landing
        const del2 = await client.query(
            `DELETE FROM transacciones WHERE usuario_id = $1 AND metodo = 'Landing'`,
            [uid]
        );
        console.log(`Transacciones Landing borradas: ${del2.rowCount}`);

        // 3. Si el usuario quedó sin transacciones, borrarlo para poder re-registrar desde cero
        const { rows: transRestantes } = await client.query(
            'SELECT COUNT(*) AS total FROM transacciones WHERE usuario_id = $1',
            [uid]
        );
        if (parseInt(transRestantes[0].total, 10) === 0) {
            await client.query('DELETE FROM usuarios WHERE id = $1', [uid]);
            console.log('Usuario eliminado (sin transacciones restantes) — puede volver a registrarse limpio');
        } else {
            console.log(`El usuario tiene ${transRestantes[0].total} transacción(es) de otro tipo y se conserva.`);
        }

        await client.query('COMMIT');
        console.log('✅ Limpieza completada correctamente');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error durante la limpieza:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

cleanup();
