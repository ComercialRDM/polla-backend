const { verificarToken } = require('../utils/userTokens');

// Acepta el token de sesión desde la cookie httpOnly (nueva) o desde
// el header Authorization: Bearer (fallback para sesiones antiguas).
function usuarioAuth(req, res, next) {
    const cookie = req.cookies?.polla_token;
    const header = req.headers.authorization || '';
    const [tipo, headerToken] = header.split(' ');

    const token = cookie || (tipo === 'Bearer' ? headerToken : null);

    if (!token) {
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
