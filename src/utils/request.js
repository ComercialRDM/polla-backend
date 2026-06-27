// Extrae la IP real del cliente. Confía en X-Forwarded-For porque server.js
// configura `trust proxy` (Render siempre llega detrás de su proxy).
function obtenerIp(req) {
    return req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
}

module.exports = { obtenerIp };
