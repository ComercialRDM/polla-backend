// Caché en memoria simple para reducir consultas repetidas en endpoints muy sondeados
// (polling del frontend). No requiere infraestructura externa (Redis).

const store = new Map();

/**
 * Devuelve el valor cacheado para `key` si sigue vigente, o ejecuta `fn`,
 * guarda el resultado por `ttlMs` y lo devuelve.
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<any>} fn
 */
async function getOrSet(key, ttlMs, fn) {
    const entrada = store.get(key);
    if (entrada && entrada.expira > Date.now()) {
        return entrada.valor;
    }

    const valor = await fn();
    store.set(key, { valor, expira: Date.now() + ttlMs });
    return valor;
}

/**
 * Elimina entradas cacheadas. Si `prefix` se indica, borra solo las claves que
 * empiezan con ese prefijo (ej. 'ranking:' para invalidar todos los rankings).
 * Sin argumentos, borra toda la caché.
 * @param {string} [prefix]
 */
function invalidate(prefix) {
    if (!prefix) {
        store.clear();
        return;
    }
    for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
    }
}

module.exports = { getOrSet, invalidate };
