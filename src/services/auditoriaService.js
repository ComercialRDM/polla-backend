const pool = require('../db');

/**
 * Registra un evento de auditoría (append-only: nunca se actualiza ni se
 * borra). Pensado para eventos que mueven dinero o cambian el estado de una
 * venta/comisión, para poder reconstruir "quién hizo qué y cuándo" si hay
 * una disputa. Nunca lanza: un fallo en auditoría no debe tumbar la
 * operación principal que la originó.
 * @param {{ tabla: string, registroId: string|number, accion: string, actor?: string, antes?: object, despues?: object, ip?: string }} datos
 */
async function registrarEvento({ tabla, registroId, accion, actor, antes, despues, ip }) {
    try {
        await pool.query(
            `INSERT INTO auditoria_eventos (tabla_afectada, registro_id, accion, actor, payload_antes, payload_despues, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tabla, String(registroId), accion, actor || 'sistema', antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null, ip || null]
        );
    } catch (err) {
        console.error('Error registrando auditoría:', err.message);
    }
}

module.exports = { registrarEvento };
