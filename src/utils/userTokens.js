const { generarToken, verificarToken } = require('./adminTokens');

// Sesión larga (30 días) para clientes finales: a diferencia de admin/local
// (staff, sesión de 12h), un usuario final no debería tener que volver a
// iniciar sesión cada día en su celular.
const TOKEN_VIGENCIA_USUARIO_SEG = 30 * 24 * 60 * 60;

function generarTokenUsuario(usuario) {
    return generarToken({ id: usuario.id, usuario: usuario.celular, role: 'USUARIO', vigenciaSeg: TOKEN_VIGENCIA_USUARIO_SEG });
}

module.exports = { generarTokenUsuario, verificarToken };
