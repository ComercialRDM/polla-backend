const pool = require('../db');
const { generarImagenBono } = require('./bonoService');
const { enviarCorreoBono } = require('./emailService');
const { enviarBonoManyChat, enviarMensajeManyChat } = require('./manychatService');
const { obtenerOcrearInfluencer } = require('./referidosService');

const VALOR_BONO_ESPECIAL_DEFAULT = 500000;
const INTENTOS_ESPECIAL_DEFAULT = 30;

// Normaliza al formato local de 10 dígitos (sin "+57"/"57"), igual que el
// resto de la app guarda el celular, para que "+573012786234" y "3012786234"
// se reconozcan como el mismo usuario en vez de crear cuentas duplicadas.
function normalizarCelular(celular) {
    const limpio = String(celular || '').replace(/\D/g, '');
    if (limpio.length === 12 && limpio.startsWith('57')) {
        return limpio.slice(2);
    }
    return limpio;
}

async function buscarProximoPartido() {
    const { rows } = await pool.query(
        `SELECT * FROM partidos WHERE estado = 'activo' ORDER BY fecha_hora_inicio ASC LIMIT 1`
    );
    return rows[0] || null;
}

async function crearUsuarioEspecial({ nombre, celular, correo }) {
    const celularNorm = normalizarCelular(celular);
    const correoNorm = correo ? correo.trim() : null;

    const { rows: existentes } = await pool.query('SELECT * FROM usuarios WHERE celular = $1', [celularNorm]);
    let usuario;
    if (existentes.length > 0) {
        usuario = existentes[0];
    } else {
        const { rows } = await pool.query(
            'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
            [nombre, correoNorm, celularNorm]
        );
        usuario = rows[0];
    }

    // Si se registró antes en /influencers y subió foto, la copiamos a su
    // cuenta para que aparezca en el ranking de creadores de contenido.
    if (!usuario.foto_imagen) {
        const { rows: fotoRows } = await pool.query(
            `SELECT foto_imagen, foto_mime FROM influencer_registros
             WHERE celular = $1 AND foto_imagen IS NOT NULL
             ORDER BY fecha_registro DESC LIMIT 1`,
            [celularNorm]
        );
        if (fotoRows.length > 0) {
            await pool.query('UPDATE usuarios SET foto_imagen = $1, foto_mime = $2 WHERE id = $3', [
                fotoRows[0].foto_imagen,
                fotoRows[0].foto_mime,
                usuario.id,
            ]);
            usuario.foto_imagen = fotoRows[0].foto_imagen;
            usuario.foto_mime = fotoRows[0].foto_mime;
        }
    }

    return usuario;
}

async function crearTransaccionEspecial({ usuarioId, partidoId, valorBono, intentos }) {
    const { rows } = await pool.query(
        `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, es_especial)
         VALUES ($1, $2, 'Especial', $3, $4, $5, 'APROBADO', TRUE)
         RETURNING *`,
        [usuarioId, partidoId, valorBono, valorBono, intentos]
    );
    return rows[0];
}

/**
 * Crea cuentas + Bonos Especiales (es_especial = TRUE) para creadores de
 * contenido/influenciadores: reciben cupos para predecir y probar la app, y
 * un bono de servicios real (válido para redimir en tienda), pero quedan
 * excluidos del ranking de premios y del Bono Colombia (ver filtros
 * `es_especial = FALSE` en rankingService.js y admin.js).
 * @param {{ personas: Array<{nombre: string, celular: string, correo?: string}>, valorBono?: number, intentos?: number }} datos
 */
async function crearBonosEspeciales({ personas, valorBono = VALOR_BONO_ESPECIAL_DEFAULT, intentos = INTENTOS_ESPECIAL_DEFAULT }) {
    const partido = await buscarProximoPartido();
    if (!partido) {
        throw new Error('No hay ningún partido activo para asociar el Bono Especial.');
    }

    const resultados = [];

    for (const persona of personas) {
        const resultado = { nombre: persona.nombre, celular: persona.celular, correo: persona.correo || null };
        try {
            const usuario = await crearUsuarioEspecial(persona);
            const transaccion = await crearTransaccionEspecial({ usuarioId: usuario.id, partidoId: partido.id, valorBono, intentos });
            const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${transaccion.token_acceso}`;
            resultado.transaccion_id = transaccion.id;
            resultado.token_acceso = transaccion.token_acceso;
            resultado.link = linkPolla;

            // Código de afiliado propio (para comisiones), distinto del
            // token_acceso de sesión que ya tiene. Se provisiona una sola vez.
            const influencer = await obtenerOcrearInfluencer(usuario.id, usuario.nombre);
            resultado.codigo_afiliado = influencer.codigo_afiliado;
            resultado.link_afiliado = `${process.env.FRONTEND_URL}/?aff=${influencer.codigo_afiliado}`;

            if (usuario.correo) {
                try {
                    const bonoBuffer = await generarImagenBono({
                        nombre: usuario.nombre,
                        saldoBono: transaccion.saldo_bono,
                        valorPagado: transaccion.valor_pagado,
                        tokenAcceso: transaccion.token_acceso,
                        esEspecial: true,
                    });
                    await enviarCorreoBono({
                        destinatario: usuario.correo,
                        nombre: usuario.nombre,
                        saldoBono: transaccion.saldo_bono,
                        intentos: transaccion.intentos_totales,
                        tokenAcceso: transaccion.token_acceso,
                        bonoBuffer,
                        esEspecial: true,
                    });
                    resultado.correoEnviado = true;
                } catch (err) {
                    resultado.correoEnviado = false;
                    resultado.errorCorreo = err.message;
                }
            }

            try {
                const mensaje = `🎖️ ¡Hola ${usuario.nombre}! Ya tienes tu BONO ESPECIAL de creador de contenido.\n\n`
                    + `Tienes $${transaccion.saldo_bono.toLocaleString('es-CO')} de bono real en La Retoucherie de Manuela (válido para redimir en tienda) y ${transaccion.intentos_totales} intentos para predecir marcadores y probar la app.\n\n`
                    + `Ingresa aquí: ${linkPolla}`;

                const { subscriberId } = await enviarBonoManyChat({
                    celular: usuario.celular,
                    mensaje,
                    imagenUrl: `${process.env.BACKEND_URL}/api/polla/bono/${transaccion.token_acceso}`,
                    subscriberId: usuario.manychat_subscriber_id,
                });

                if (subscriberId && !usuario.manychat_subscriber_id) {
                    await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), usuario.id]);
                }

                resultado.whatsappEnviado = true;
            } catch (err) {
                resultado.whatsappEnviado = false;
                resultado.errorWhatsapp = err.response?.data || err.message;
            }
        } catch (err) {
            resultado.error = err.message;
        }

        resultados.push(resultado);
    }

    return {
        partido: { id: partido.id, equipo_local: partido.equipo_local, equipo_visitante: partido.equipo_visitante },
        resultados,
    };
}

async function listarBonosEspeciales() {
    const { rows } = await pool.query(
        `SELECT t.id AS transaccion_id, t.token_acceso, t.saldo_bono, t.intentos_totales, t.intentos_usados,
                t.fecha_creacion, u.id AS usuario_id, u.nombre, u.celular, u.correo,
                i.codigo_afiliado, i.porcentaje_comision
         FROM transacciones t
         JOIN usuarios u ON u.id = t.usuario_id
         LEFT JOIN influencers i ON i.usuario_id = u.id
         WHERE t.es_especial = TRUE
         ORDER BY t.fecha_creacion DESC`
    );
    return rows;
}

/**
 * Envía por WhatsApp el "kit de difusión" para que el creador de contenido
 * sepa qué decirle a sus seguidores: pasos para participar, beneficios de
 * La Retoucherie y su link personal de referido (el mismo token_acceso del
 * Bono Especial, reutilizando el sistema de referidos ya existente).
 */
async function enviarInvitacionDifusion(transaccionId) {
    const { rows } = await pool.query(
        `SELECT t.token_acceso, t.saldo_bono, u.nombre, u.celular, u.manychat_subscriber_id,
                i.codigo_afiliado
         FROM transacciones t
         JOIN usuarios u ON u.id = t.usuario_id
         LEFT JOIN influencers i ON i.usuario_id = u.id
         WHERE t.id = $1 AND t.es_especial = TRUE`,
        [transaccionId]
    );
    if (rows.length === 0) {
        throw new Error('Bono Especial no encontrado');
    }
    const { token_acceso, saldo_bono, nombre, celular, manychat_subscriber_id, codigo_afiliado } = rows[0];
    const linkReferido = `${process.env.FRONTEND_URL}/?ref=${token_acceso}`;
    const linkAfiliado = codigo_afiliado ? `${process.env.FRONTEND_URL}/?aff=${codigo_afiliado}` : null;

    // El porcentaje_comision NUNCA se le muestra al influencer (por correo, SMS
    // o WhatsApp) — solo se calcula/ve en el panel admin. El link de afiliado sí
    // se le comparte (para que lo difunda), pero sin revelar la tasa.
    const mensaje = `🇨🇴⚽ ¡Hola ${nombre}! Aquí tienes todo para contarle a tus seguidores cómo participar en la Polla Mundialista de La Retoucherie de Manuela:\n\n`
        + `1️⃣ Entran a ${linkReferido}\n`
        + `2️⃣ Predicen el marcador del próximo partido de Colombia\n`
        + `3️⃣ Compran su Bono Digital (desde $10.000): incluye crédito real en La Retoucherie para arreglos y transformaciones de ropa + cupos para predecir\n`
        + `4️⃣ ¡Pueden ganar hasta $1.000.000 en el Bono Colombia si aciertan el marcador exacto!\n\n`
        + `✂️ La Retoucherie de Manuela arregla y transforma ropa a la medida (dobladillos, ajustes, transformaciones) en Barranquilla.\n\n`
        + `🎁 Como creador de contenido ya tienes tu Bono Especial de $${saldo_bono.toLocaleString('es-CO')} en arreglos de ropa, ¡totalmente real y listo para usar en tienda!\n\n`
        + `👉 Tu link personal (para que rastreemos a quienes invites): ${linkReferido}`
        + (linkAfiliado
            ? `\n\n🔗 También tienes tu link de afiliado para compartir: ${linkAfiliado}`
            : '');

    const { subscriberId } = await enviarMensajeManyChat({ celular, mensaje, subscriberId: manychat_subscriber_id });

    if (subscriberId && !manychat_subscriber_id) {
        await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = (SELECT usuario_id FROM transacciones WHERE id = $2)', [String(subscriberId), transaccionId]);
    }

    return { enviado: true };
}

/**
 * Ranking SOLO entre cuentas de Bono Especial (influenciadores/creadores de
 * contenido), con la misma fórmula de puntaje que el ranking global. Lo usa
 * tanto el panel admin (GET /api/admin/ranking-especiales) como el ranking
 * que ve cada influencer en su propio link (GET /api/polla/ranking-influencers).
 */
async function obtenerRankingEspeciales() {
    const { rows } = await pool.query(
        `SELECT u.id, u.nombre, u.celular, (u.foto_imagen IS NOT NULL) AS tiene_foto,
                COALESCE(SUM(
                    CASE
                        WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante
                             AND pa.goles_local IS NOT NULL
                        THEN CASE pa.fase
                            WHEN 'grupos'        THEN 100
                            WHEN 'dieciseisavos' THEN 200
                            WHEN 'octavos'       THEN 200
                            WHEN 'cuartos'       THEN 600
                            WHEN 'semifinal'     THEN 600
                            WHEN 'final'         THEN 1000
                            ELSE 100 END
                        WHEN pr.goles_local IS NOT NULL AND pa.goles_local IS NOT NULL
                             AND SIGN(pr.goles_local - pr.goles_visitante) = SIGN(pa.goles_local - pa.goles_visitante)
                             AND NOT (pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante)
                        THEN CASE pa.fase
                            WHEN 'grupos'        THEN 50
                            WHEN 'dieciseisavos' THEN 100
                            WHEN 'octavos'       THEN 100
                            WHEN 'cuartos'       THEN 300
                            WHEN 'semifinal'     THEN 300
                            WHEN 'final'         THEN 500
                            ELSE 50 END
                        ELSE 0
                    END
                ), 0) AS puntos_total,
                COUNT(
                    CASE WHEN pr.goles_local = pa.goles_local AND pr.goles_visitante = pa.goles_visitante
                              AND pa.goles_local IS NOT NULL THEN 1 END
                ) AS exactos
         FROM usuarios u
         LEFT JOIN pronosticos pr ON pr.usuario_id = u.id
         LEFT JOIN partidos pa ON pa.id = pr.partido_id AND pa.estado = 'cerrado'
         WHERE u.id IN (SELECT usuario_id FROM transacciones WHERE es_especial = TRUE)
         GROUP BY u.id, u.nombre, u.celular, u.foto_imagen
         ORDER BY puntos_total DESC, exactos DESC`
    );

    return rows.map((u, i) => ({
        posicion: i + 1,
        id: u.id,
        nombre: u.nombre,
        celular: u.celular,
        tiene_foto: u.tiene_foto,
        puntos: Number(u.puntos_total),
        exactos: Number(u.exactos),
    }));
}

module.exports = {
    crearBonosEspeciales,
    listarBonosEspeciales,
    enviarInvitacionDifusion,
    obtenerRankingEspeciales,
    VALOR_BONO_ESPECIAL_DEFAULT,
    INTENTOS_ESPECIAL_DEFAULT,
};
