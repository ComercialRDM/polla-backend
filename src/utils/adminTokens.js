const crypto = require('crypto');

// Secreto para firmar los tokens de sesión del panel de administración.
// Si no está definido ADMIN_JWT_SECRET, se usa un valor aleatorio generado en
// memoria (las sesiones no sobreviven a un reinicio del servidor).
const SECRET = process.env.ADMIN_JWT_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.ADMIN_JWT_SECRET) {
    console.warn('ADMIN_JWT_SECRET no está configurado: las sesiones admin se invalidarán en cada reinicio. Define ADMIN_JWT_SECRET en las variables de entorno.');
}

const TOKEN_VIGENCIA_SEG = 12 * 60 * 60; // 12 horas

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function firmar(data) {
    return base64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

/**
 * Genera un token de sesión firmado. El rol queda explícito en el payload
 * para que cada middleware (RBAC) lo verifique: "ADMIN" para admin_usuarios,
 * "LOCAL" para local_usuarios (cuentas de redención de bonos por local).
 * @param {{ id: number, usuario: string, role?: string }} datos
 * @returns {string}
 */
function generarToken({ id, usuario, role = 'ADMIN' }) {
    const payload = JSON.stringify({ id, usuario, role, exp: Math.floor(Date.now() / 1000) + TOKEN_VIGENCIA_SEG });
    const payloadB64 = base64url(payload);
    return `${payloadB64}.${firmar(payloadB64)}`;
}

/**
 * Verifica un token de sesión y devuelve su payload si es válido y no ha expirado.
 * @param {string} token
 * @returns {{ id: number, usuario: string, role: string } | null}
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
        return { id: payload.id, usuario: payload.usuario, role: payload.role };
    } catch {
        return null;
    }
}

module.exports = { generarToken, verificarToken };
