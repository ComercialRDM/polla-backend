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

module.exports = { normalizarCelular };
