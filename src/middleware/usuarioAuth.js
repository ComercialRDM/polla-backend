const { verificarToken } = require('../utils/userTokens');

// Middleware de autenticación para clientes finales (no admin/local). Resuelve
// la identidad del usuario a partir de un token firmado en vez de confiar en
// un usuario_id que el cliente pueda mandar libremente (eso era un IDOR: ver
// /api/polla/resumen-usuario y /api/polla/mis-pronosticos antes de este fix).
function usuarioAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const sesion = verificarToken(token);
    if (!sesion || sesion.role !== 'USUARIO') {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    req.usuario = sesion;
    next();
}

module.exports = usuarioAuth;
