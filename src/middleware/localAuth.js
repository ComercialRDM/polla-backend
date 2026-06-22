const { verificarToken } = require('../utils/adminTokens');
const pool = require('../db');

// Middleware de autenticación + control de acceso por rol (RBAC) para las
// cuentas de los locales (redención de bonos en /redimircodigordm). Solo
// acepta tokens emitidos por /api/local/login cuyo payload declare
// explícitamente role: "LOCAL". Separado de adminAuth: una cuenta de local
// no puede acceder a las rutas /api/admin.
async function localAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const sesion = verificarToken(token);
    if (!sesion) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    if (sesion.role !== 'LOCAL') {
        return res.status(403).json({ success: false, error: 'Acceso prohibido: se requiere cuenta de local' });
    }

    // Revocación: si se reseteó la contraseña de este local desde que se
    // emitió el token, queda invalidado aunque no haya expirado.
    try {
        const { rows } = await pool.query(
            'SELECT token_version FROM local_usuarios WHERE id = $1 AND activo = TRUE',
            [sesion.id]
        );
        if (!rows.length || rows[0].token_version !== sesion.tv) {
            return res.status(401).json({ success: false, error: 'Sesión inválida. Vuelve a iniciar sesión.' });
        }
    } catch (err) {
        console.error('localAuth: error verificando token_version:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }

    req.local = sesion;
    return next();
}

module.exports = localAuth;
