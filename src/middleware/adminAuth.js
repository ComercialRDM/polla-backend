const { verificarToken } = require('../utils/adminTokens');
const pool = require('../db');

// Middleware de autenticación + control de acceso por rol (RBAC) para el
// panel de administración. Solo acepta tokens emitidos por /api/admin/login
// cuyo payload declare explícitamente role: "ADMIN".
async function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const sesion = verificarToken(token);
    if (!sesion) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    if (sesion.role !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Acceso prohibido: se requiere rol ADMIN' });
    }

    // Revocación: si el token_version de la cuenta cambió desde que se emitió
    // este token (ej. se desactivó el 2FA), el token queda invalidado aunque
    // no haya expirado.
    try {
        const { rows } = await pool.query(
            'SELECT token_version FROM admin_usuarios WHERE id = $1 AND activo = TRUE',
            [sesion.id]
        );
        if (!rows.length || rows[0].token_version !== sesion.tv) {
            return res.status(401).json({ success: false, error: 'Sesión inválida. Vuelve a iniciar sesión.' });
        }
    } catch (err) {
        console.error('adminAuth: error verificando token_version:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }

    req.admin = sesion;
    return next();
}

module.exports = adminAuth;
