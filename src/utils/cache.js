// Caché con Redis (cuando REDIS_URL está disponible) y fallback a memoria.
// Los endpoints de polling usan esto para reducir carga en la BD.

const store = new Map();
let redisClient = null;

if (process.env.REDIS_URL) {
    try {
        const Redis = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            enableReadyCheck: false,
            maxRetriesPerRequest: 1,
            connectTimeout: 3000,
            lazyConnect: true,
        });
        redisClient.on('error', (err) => console.warn('[cache] Redis:', err.message));
        console.log('[cache] Redis configurado:', process.env.REDIS_URL.split('@').pop());
    } catch (err) {
        console.warn('[cache] ioredis no disponible, usando caché en memoria:', err.message);
    }
}

async function getOrSet(key, ttlMs, fn) {
    if (redisClient) {
        try {
            const cached = await redisClient.get(key);
            if (cached !== null) return JSON.parse(cached);
            const valor = await fn();
            await redisClient.set(key, JSON.stringify(valor), 'PX', ttlMs);
            return valor;
        } catch (_) {
            // Redis falló — cae a caché en memoria
        }
    }

    const entrada = store.get(key);
    if (entrada && entrada.expira > Date.now()) return entrada.valor;
    const valor = await fn();
    store.set(key, { valor, expira: Date.now() + ttlMs });
    return valor;
}

function invalidate(prefix) {
    if (!prefix) {
        store.clear();
    } else {
        for (const key of store.keys()) {
            if (key.startsWith(prefix)) store.delete(key);
        }
    }

    if (redisClient) {
        if (!prefix) {
            redisClient.flushdb().catch(() => {});
        } else {
            redisClient.keys(`${prefix}*`)
                .then((keys) => { if (keys.length) redisClient.del(...keys); })
                .catch(() => {});
        }
    }
}

module.exports = { getOrSet, invalidate };
