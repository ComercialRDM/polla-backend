const pool = require('../db');
const { enviarCorreoResultadoPartido } = require('./emailService');
const { obtenerSaldoUsuario } = require('./walletService');
const { puntajeExacto, puntajeTendencia } = require('../config/puntajesFase');
const { ejecutarConConcurrencia } = require('../utils/concurrencia');

const CONCURRENCIA_CORREOS = 10;

/**
 * Manda el correo de "resultado del partido + recompra" a cada participante
 * real (excluye pruebas/especiales) de un partido recién cerrado — reemplaza
 * las notificaciones de inicio de partido/gol que antes se mandaban por
 * WhatsApp (ver auditoria_eventos / decisión de migrar a correo por costo).
 * Es idempotente vía la tabla recompra_enviada: no reenvía si ya se mandó
 * para ese usuario/partido, sin importar si el cierre vino del panel admin
 * (PATCH /admin/partidos/:id) o del monitor automático de marcadores
 * (marcadoresService.js) — ambos llaman a esta misma función.
 * @param {{ id: number, equipo_local: string, equipo_visitante: string, goles_local: number, goles_visitante: number, fase: string }} partido
 */
async function enviarCorreosResultadoPartido(partido) {
    if (partido.goles_local === null || partido.goles_visitante === null) return;

    const { rows: participantes } = await pool.query(
        `SELECT pr.usuario_id, pr.goles_local AS pred_local, pr.goles_visitante AS pred_visitante,
                u.nombre, u.correo
         FROM pronosticos pr
         JOIN usuarios u ON u.id = pr.usuario_id
         LEFT JOIN transacciones t ON t.id = pr.transaccion_id
         WHERE pr.partido_id = $1
           AND u.correo IS NOT NULL
           AND COALESCE(t.es_test, FALSE) = FALSE
           AND COALESCE(t.es_especial, FALSE) = FALSE`,
        [partido.id]
    );
    if (participantes.length === 0) return;

    const pendientes = [];
    for (const p of participantes) {
        const { rows: insertado } = await pool.query(
            `INSERT INTO recompra_enviada (partido_id, usuario_id) VALUES ($1, $2)
             ON CONFLICT (partido_id, usuario_id) DO NOTHING RETURNING id`,
            [partido.id, p.usuario_id]
        );
        if (insertado.length > 0) pendientes.push(p);
    }
    if (pendientes.length === 0) return;

    const { rows: proximoRows } = await pool.query(
        `SELECT equipo_local, equipo_visitante FROM partidos
         WHERE estado = 'activo' AND fecha_hora_inicio > now()
         ORDER BY fecha_hora_inicio ASC LIMIT 1`
    );
    const proximoPartido = proximoRows[0]
        ? { equipoLocal: proximoRows[0].equipo_local, equipoVisitante: proximoRows[0].equipo_visitante }
        : null;
    const linkCompra = `${process.env.FRONTEND_URL}/comprar`;

    await ejecutarConConcurrencia(pendientes, async (p) => {
        try {
            const esExacto = p.pred_local === partido.goles_local && p.pred_visitante === partido.goles_visitante;
            const esTendencia = !esExacto
                && Math.sign(p.pred_local - p.pred_visitante) === Math.sign(partido.goles_local - partido.goles_visitante);
            const puntosGanados = esExacto ? puntajeExacto(partido.fase) : esTendencia ? puntajeTendencia(partido.fase) : 0;
            const { cuposDisponibles } = await obtenerSaldoUsuario(p.usuario_id);

            await enviarCorreoResultadoPartido({
                destinatario: p.correo,
                nombre: p.nombre,
                equipoLocal: partido.equipo_local,
                equipoVisitante: partido.equipo_visitante,
                golesLocal: partido.goles_local,
                golesVisitante: partido.goles_visitante,
                prediccionLocal: p.pred_local,
                prediccionVisitante: p.pred_visitante,
                puntosGanados,
                cuposDisponibles,
                proximoPartido,
                linkCompra,
            });
        } catch (err) {
            console.error(`Error enviando correo de resultado a ${p.correo}:`, err.message);
        }
    }, CONCURRENCIA_CORREOS);
}

module.exports = { enviarCorreosResultadoPartido };
