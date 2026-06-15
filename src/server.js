require('dotenv').config();

const Sentry = require('./instrument');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

const pool = require('./db');
const transaccionesRouter = require('./routes/transacciones');
const webhooksRouter = require('./routes/webhooks');
const pollaRouter = require('./routes/polla');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const partidosRouter = require('./routes/partidos');
const { authLimiter, adminLimiter, transaccionesLimiter } = require('./middleware/rateLimiters');
const { iniciarMonitorPartidos } = require('./services/notificacionesService');
const { iniciarMonitorMarcadores } = require('./services/marcadoresService');

const app = express();

// Render coloca la app detrás de un proxy que agrega X-Forwarded-For; sin esto,
// express-rate-limit rechaza las peticiones por considerarlo un header no confiable.
app.set('trust proxy', 1);

// Orígenes permitidos para CORS (separados por coma). Si no se define, permite todos
// los orígenes (modo permisivo de respaldo, pero se recomienda configurar FRONTEND_URL).
const origenesPermitidos = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origen) => origen.trim())
    .filter(Boolean);

if (origenesPermitidos.length === 0) {
    console.warn('FRONTEND_URL no está configurado: CORS permitirá cualquier origen.');
}

// CSP no aplica a una API que solo devuelve JSON/imágenes; se desactiva para evitar
// interferencias. Se permite que /api/polla/bono/:token (imagen del bono) se cargue
// desde el frontend (otro origen) y desde WhatsApp/ManyChat.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({
    origin: origenesPermitidos.length > 0 ? origenesPermitidos : true,
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/transacciones', transaccionesLimiter, transaccionesRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/polla', pollaRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/admin', adminLimiter, adminRouter);
app.use('/api/partidos', partidosRouter);

// Reporta a Sentry los errores no controlados que lleguen hasta aquí
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

// Manejo de errores de subida de archivos (multer) y otros errores no controlados
app.use((err, req, res, next) => {
    if (err) {
        console.error('Error no controlado:', err.message);
        return res.status(400).json({ success: false, error: err.message || 'Error procesando la solicitud' });
    }
    next();
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`Servidor de la Polla Mundialista corriendo en http://localhost:${PORT}`);

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS equipos_favoritos TEXT[] NOT NULL DEFAULT '{}'`);
    } catch (err) {
        console.error('Error aplicando migración de equipos_favoritos:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash TEXT`);
        await pool.query(`ALTER TABLE usuarios ALTER COLUMN correo DROP NOT NULL`);
    } catch (err) {
        console.error('Error aplicando migración de password_hash:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_code VARCHAR(6)`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_code_expira TIMESTAMPTZ`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_intentos INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
        console.error('Error aplicando migración de reset_code:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS manychat_subscriber_id TEXT`);
    } catch (err) {
        console.error('Error aplicando migración de manychat_subscriber_id:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE`);
    } catch (err) {
        console.error('Error aplicando migración de google_id:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS bono_consumido BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS bono_consumido_en TIMESTAMPTZ`);
    } catch (err) {
        console.error('Error aplicando migración de bono_consumido:', err.message);
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
        console.warn('GOOGLE_CLIENT_ID no está configurado: el login con Google no funcionará.');
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_usuarios (
                id SERIAL PRIMARY KEY,
                usuario TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                activo BOOLEAN NOT NULL DEFAULT TRUE,
                fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        // Si la tabla está vacía, se crea la primera cuenta a partir de
        // ADMIN_SEED_USUARIO / ADMIN_SEED_PASSWORD para no quedar sin acceso.
        const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM admin_usuarios');
        if (rows[0].total === 0) {
            if (process.env.ADMIN_SEED_USUARIO && process.env.ADMIN_SEED_PASSWORD) {
                const passwordHash = await bcrypt.hash(process.env.ADMIN_SEED_PASSWORD, 10);
                await pool.query(
                    'INSERT INTO admin_usuarios (usuario, password_hash) VALUES ($1, $2)',
                    [process.env.ADMIN_SEED_USUARIO, passwordHash]
                );
                console.log(`Cuenta de administrador inicial creada para "${process.env.ADMIN_SEED_USUARIO}"`);
            } else {
                console.warn('No hay cuentas en admin_usuarios. Define ADMIN_SEED_USUARIO y ADMIN_SEED_PASSWORD para crear la primera.');
            }
        }
    } catch (err) {
        console.error('Error aplicando migración de admin_usuarios:', err.message);
    }

    iniciarMonitorPartidos();
    iniciarMonitorMarcadores();
});
