const express = require('express');
const pool = require('../db');

const router = express.Router();

async function resolverUsuario(token_acceso) {
    const { rows } = await pool.query(
        `SELECT u.id AS usuario_id, u.nombre, (u.foto_imagen IS NOT NULL) AS tiene_foto
         FROM transacciones t
         JOIN usuarios u ON u.id = t.usuario_id
         WHERE t.token_acceso = $1 AND t.estado_pago = 'APROBADO'
         LIMIT 1`,
        [token_acceso]
    );
    return rows[0] || null;
}

// Correlated subquery que calcula puntos totales de un usuario por alias u
const SUB_PUNTOS = `(
    SELECT COALESCE(SUM(
        CASE
            WHEN pa.estado = 'cerrado'
                 AND pr2.goles_local = pa.goles_local
                 AND pr2.goles_visitante = pa.goles_visitante
            THEN CASE pa.fase
                WHEN 'grupos'        THEN 100
                WHEN 'dieciseisavos' THEN 200
                WHEN 'octavos'       THEN 200
                WHEN 'cuartos'       THEN 600
                WHEN 'semifinal'     THEN 600
                WHEN 'final'         THEN 1000
                ELSE 100
            END
            WHEN pa.estado = 'cerrado' AND (
                (pr2.goles_local > pr2.goles_visitante AND pa.goles_local > pa.goles_visitante) OR
                (pr2.goles_local < pr2.goles_visitante AND pa.goles_local < pa.goles_visitante) OR
                (pr2.goles_local = pr2.goles_visitante AND pa.goles_local = pa.goles_visitante)
            ) AND NOT (pr2.goles_local = pa.goles_local AND pr2.goles_visitante = pa.goles_visitante)
            THEN CASE pa.fase
                WHEN 'grupos'        THEN 50
                WHEN 'dieciseisavos' THEN 100
                WHEN 'octavos'       THEN 100
                WHEN 'cuartos'       THEN 300
                WHEN 'semifinal'     THEN 300
                WHEN 'final'         THEN 500
                ELSE 50
            END
            ELSE 0
        END
    ), 0)::int
    FROM pronosticos pr2
    JOIN partidos pa ON pa.id = pr2.partido_id
    WHERE pr2.usuario_id = u.id
)`;

// POST /api/grupo — crear grupo
router.post('/', async (req, res) => {
    const { token_acceso, nombre, partido_id } = req.body;
    if (!token_acceso || !nombre?.trim() || !partido_id) {
        return res.status(400).json({ success: false, error: 'Faltan datos' });
    }

    const usuario = await resolverUsuario(token_acceso).catch(() => null);
    if (!usuario) return res.status(401).json({ success: false, error: 'Token no válido' });

    const { rows: pRows } = await pool.query(
        `SELECT id FROM partidos WHERE id = $1 AND estado = 'activo'`,
        [Number(partido_id)]
    );
    if (pRows.length === 0) {
        return res.status(400).json({ success: false, error: 'Partido no válido o ya cerrado' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO grupos (nombre, admin_usuario_id, partido_id)
             VALUES ($1, $2, $3) RETURNING token_grupo, id`,
            [nombre.trim().substring(0, 100), usuario.usuario_id, Number(partido_id)]
        );
        const { token_grupo, id: grupo_id } = rows[0];

        // El admin queda como primer miembro automáticamente
        await pool.query(
            `INSERT INTO grupo_miembros (grupo_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [grupo_id, usuario.usuario_id]
        );

        return res.json({ success: true, token_grupo });
    } catch (err) {
        console.error('Error creando grupo:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/grupo/mio?token_acceso=xxx — grupos del usuario
router.get('/mio', async (req, res) => {
    const { token_acceso } = req.query;
    if (!token_acceso) return res.status(400).json({ success: false, error: 'Falta token_acceso' });

    const usuario = await resolverUsuario(token_acceso).catch(() => null);
    if (!usuario) return res.status(401).json({ success: false, error: 'Token no válido' });

    try {
        const { rows } = await pool.query(
            `SELECT g.token_grupo, g.nombre, g.max_miembros,
                    (g.admin_usuario_id = $1) AS es_admin,
                    p.equipo_local, p.equipo_visitante, p.fecha_hora_inicio, p.estado AS estado_partido,
                    (SELECT COUNT(*)::int FROM grupo_miembros gm2 WHERE gm2.grupo_id = g.id) AS total_miembros
             FROM grupo_miembros gm
             JOIN grupos g ON g.id = gm.grupo_id
             JOIN partidos p ON p.id = g.partido_id
             WHERE gm.usuario_id = $1
             ORDER BY g.created_at DESC`,
            [usuario.usuario_id]
        );
        return res.json({ success: true, grupos: rows });
    } catch (err) {
        console.error('Error obteniendo grupos del usuario:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/grupo/:token — dashboard del grupo (público, token_acceso opcional para identificar al visitante)
router.get('/:token', async (req, res) => {
    const { token } = req.params;
    const { token_acceso } = req.query;

    try {
        const { rows: gRows } = await pool.query(
            `SELECT g.id, g.nombre, g.admin_usuario_id, g.max_miembros,
                    p.id AS partido_id, p.equipo_local, p.equipo_visitante,
                    p.fecha_hora_inicio, p.estado, p.fase,
                    p.goles_local AS resultado_local, p.goles_visitante AS resultado_visitante
             FROM grupos g
             JOIN partidos p ON p.id = g.partido_id
             WHERE g.token_grupo = $1`,
            [token]
        );

        if (gRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Grupo no encontrado' });
        }

        const grupo = gRows[0];

        let miUsuarioId = null;
        if (token_acceso) {
            const u = await resolverUsuario(token_acceso).catch(() => null);
            miUsuarioId = u?.usuario_id || null;
        }

        const { rows: miembros } = await pool.query(
            `SELECT
                u.id AS usuario_id,
                u.nombre,
                (u.foto_imagen IS NOT NULL) AS tiene_foto,
                gm.joined_at,
                (g.admin_usuario_id = u.id) AS es_admin,
                pr_p.goles_local AS pred_local,
                pr_p.goles_visitante AS pred_visitante,
                ${SUB_PUNTOS} + COALESCE(u.puntos_bonus, 0) AS puntos_total
             FROM grupo_miembros gm
             JOIN grupos g ON g.id = gm.grupo_id
             JOIN usuarios u ON u.id = gm.usuario_id
             LEFT JOIN pronosticos pr_p ON pr_p.usuario_id = u.id AND pr_p.partido_id = $2
             WHERE gm.grupo_id = $1
             ORDER BY puntos_total DESC, gm.joined_at ASC`,
            [grupo.id, grupo.partido_id]
        );

        return res.json({
            success: true,
            grupo: {
                token_grupo: token,
                nombre: grupo.nombre,
                admin_usuario_id: grupo.admin_usuario_id,
                max_miembros: grupo.max_miembros,
                total_miembros: miembros.length,
            },
            partido: {
                partido_id: grupo.partido_id,
                equipo_local: grupo.equipo_local,
                equipo_visitante: grupo.equipo_visitante,
                fecha_hora_inicio: grupo.fecha_hora_inicio,
                estado: grupo.estado,
                fase: grupo.fase,
                resultado_local: grupo.resultado_local,
                resultado_visitante: grupo.resultado_visitante,
            },
            miembros,
            mi_usuario_id: miUsuarioId,
            soy_miembro: miUsuarioId ? miembros.some((m) => m.usuario_id === miUsuarioId) : false,
        });
    } catch (err) {
        console.error('Error obteniendo grupo:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/grupo/:token/unirse
router.post('/:token/unirse', async (req, res) => {
    const { token } = req.params;
    const { token_acceso } = req.body;
    if (!token_acceso) return res.status(400).json({ success: false, error: 'Falta token_acceso' });

    const usuario = await resolverUsuario(token_acceso).catch(() => null);
    if (!usuario) return res.status(401).json({ success: false, error: 'Token no válido' });

    try {
        const { rows: gRows } = await pool.query(
            `SELECT id, max_miembros FROM grupos WHERE token_grupo = $1`,
            [token]
        );
        if (gRows.length === 0) return res.status(404).json({ success: false, error: 'Grupo no encontrado' });

        const { id: grupoId, max_miembros } = gRows[0];

        // Idempotente: si ya es miembro devuelve éxito
        const { rows: yaRows } = await pool.query(
            `SELECT 1 FROM grupo_miembros WHERE grupo_id = $1 AND usuario_id = $2`,
            [grupoId, usuario.usuario_id]
        );
        if (yaRows.length > 0) return res.json({ success: true, ya_miembro: true });

        const { rows: countRows } = await pool.query(
            `SELECT COUNT(*)::int AS total FROM grupo_miembros WHERE grupo_id = $1`,
            [grupoId]
        );
        if (countRows[0].total >= max_miembros) {
            return res.status(400).json({ success: false, error: `El grupo ya está lleno (máx. ${max_miembros} personas)` });
        }

        await pool.query(
            `INSERT INTO grupo_miembros (grupo_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [grupoId, usuario.usuario_id]
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('Error uniéndose al grupo:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
