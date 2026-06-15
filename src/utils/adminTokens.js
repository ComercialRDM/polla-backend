const crypto = require('crypto');

// Secreto para firmar los tokens de sesión del panel de administración.
// Se recomienda definir ADMIN_JWT_SECRET en producción. Si no está definido,
// se usa ADMIN_API_KEY (si existe) como respaldo y, en último caso, un valor
// aleatorio generado en memoria (las sesiones no sobreviven a un reinicio).
const SECRET = process.env.ADMIN_JWT_SECRET || process.env.ADMIN_API_KEY || crypto.randomBytes(32).toString('hex');

if (!process.env.ADMIN_JWT_SECRET) {
    console.warn('ADMIN_JWT_SECRET no está configurado: se usará un secreto de respaldo. Define ADMIN_JWT_SECRET para sesiones admin estables entre reinicios.');
}

const TOKEN_VIGENCIA_SEG = 12 * 60 * 60; // 12 horas

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function firmar(data) {
    return base64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

/**
 * Genera un token de sesión firmado para un administrador.
 * @param {{ id: number, usuario: string }} datos
 * @returns {string}
 */
function generarToken({ id, usuario }) {
    const payload = JSON.stringify({ id, usuario, exp: Math.floor(Date.now() / 1000) + TOKEN_VIGENCIA_SEG });
    const payloadB64 = base64url(payload);
    return `${payloadB64}.${firmar(payloadB64)}`;
}

/**
 * Verifica un token de sesión y devuelve su payload si es válido y no ha expirado.
 * @param {string} token
 * @returns {{ id: number, usuario: string } | null}
 */
function verificarToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;

    const [payloadB64, firma] = token.split('.');
    const firmaEsperada = firmar(payloadB64);

    const bufFirma = Buffer.from(firma);
    const bufEsperada = Buffer.from(firmaEsperada);
    if (bufFirma.length !== bufEsperada.length || !crypto.timingSafeEqual(bufFirma, bufEsperada)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return { id: payload.id, usuario: payload.usuario };
    } catch {
        return null;
    }
}

module.exports = { generarToken, verificarToken };
