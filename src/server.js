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
const simuladorRouter = require('./routes/simulador');
const localRouter = require('./routes/local');
const partidosRouter  = require('./routes/partidos');
const passkeysRouter  = require('./routes/passkeys');
const influencersRouter = require('./routes/influencers');
const referidosRouter = require('./routes/referidos');
const { authLimiter, adminLimiter, transaccionesLimiter, pollaLimiter, webhooksLimiter, influencersLimiter, clicLimiter } = require('./middleware/rateLimiters');
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
    console.warn('FRONTEND_URL no está configurado: CORS solo permitirá localhost (desarrollo).');
}

// CSP no aplica a una API que solo devuelve JSON/imágenes; se desactiva para evitar
// interferencias. Se permite que /api/polla/bono/:token (imagen del bono) se cargue
// desde el frontend (otro origen) y desde WhatsApp/ManyChat.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'", 'https://api.manychat.com', 'https://sandbox.wompi.co', 'https://production.wompi.co'],
            fontSrc: ["'self'", 'https:', 'data:'],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
        },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({
    origin: origenesPermitidos.length > 0 ? origenesPermitidos : ['http://localhost:5173'],
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/transacciones', transaccionesLimiter, transaccionesRouter);
app.use('/api/webhooks', webhooksLimiter, webhooksRouter);
app.use('/api/polla', pollaLimiter, pollaRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/admin', adminLimiter, adminRouter);
app.use('/api/admin/simulador', adminLimiter, simuladorRouter);
app.use('/api/local', adminLimiter, localRouter);
app.use('/api/partidos', pollaLimiter, partidosRouter);
app.use('/api/passkey', authLimiter, passkeysRouter);
app.use('/api/influencers', influencersLimiter, influencersRouter);
app.use('/api/referidos', clicLimiter, referidosRouter);

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
                totp_secret TEXT,
                totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                activo BOOLEAN NOT NULL DEFAULT TRUE,
                fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        await pool.query(`ALTER TABLE admin_usuarios ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
        await pool.query(`ALTER TABLE admin_usuarios ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`ALTER TABLE admin_usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`);

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

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS manychat_metricas_diarias (
                fecha               DATE PRIMARY KEY,
                mensajes_enviados   INTEGER NOT NULL DEFAULT 0,
                aperturas           INTEGER NOT NULL DEFAULT 0,
                clics               INTEGER NOT NULL DEFAULT 0,
                fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    } catch (err) {
        console.error('Error aplicando migración de manychat_metricas_diarias:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS local_usuarios (
                id              SERIAL PRIMARY KEY,
                usuario         TEXT UNIQUE NOT NULL,
                password_hash   TEXT NOT NULL,
                nombre_local    TEXT,
                correo          TEXT,
                activo          BOOLEAN NOT NULL DEFAULT TRUE,
                fecha_creacion  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await pool.query(`ALTER TABLE local_usuarios ADD COLUMN IF NOT EXISTS correo TEXT`);
        await pool.query(`ALTER TABLE local_usuarios ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
        await pool.query(`ALTER TABLE local_usuarios ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
        await pool.query(`ALTER TABLE local_usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`);

        // Si la tabla está vacía, se crean las cuentas de los locales a partir de
        // LOCAL_SEED_USUARIO_1..5 / LOCAL_SEED_PASSWORD_1..5 / LOCAL_SEED_NOMBRE_1..5
        const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM local_usuarios');
        if (rows[0].total === 0) {
            let creadas = 0;
            for (let i = 1; i <= 5; i++) {
                const usuario = process.env[`LOCAL_SEED_USUARIO_${i}`];
                const password = process.env[`LOCAL_SEED_PASSWORD_${i}`];
                if (usuario && password) {
                    const passwordHash = await bcrypt.hash(password, 10);
                    await pool.query(
                        'INSERT INTO local_usuarios (usuario, password_hash, nombre_local) VALUES ($1, $2, $3)',
                        [usuario, passwordHash, process.env[`LOCAL_SEED_NOMBRE_${i}`] || null]
                    );
                    creadas += 1;
                }
            }
            if (creadas > 0) {
                console.log(`${creadas} cuenta(s) de local creada(s) para /redimircodigordm`);
            } else {
                console.warn('No hay cuentas en local_usuarios. Define LOCAL_SEED_USUARIO_1..5 y LOCAL_SEED_PASSWORD_1..5 para crear las cuentas de los locales.');
            }
        }
    } catch (err) {
        console.error('Error aplicando migración de local_usuarios:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS passkeys (
                id            SERIAL PRIMARY KEY,
                usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                credential_id TEXT NOT NULL UNIQUE,
                public_key    TEXT NOT NULL,
                counter       BIGINT NOT NULL DEFAULT 0,
                device_type   TEXT,
                backed_up     BOOLEAN DEFAULT FALSE,
                transports    TEXT[],
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    } catch (err) {
        console.error('Error creando tabla passkeys:', err.message);
    }

    try {
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'pronosticos' AND column_name = 'transaccion_id' AND is_nullable = 'NO'
                ) THEN
                    ALTER TABLE pronosticos ALTER COLUMN transaccion_id DROP NOT NULL;
                END IF;
            END $$;
        `);
        await pool.query(`ALTER TABLE pronosticos ADD COLUMN IF NOT EXISTS es_flash BOOLEAN DEFAULT FALSE`);
    } catch (err) {
        console.error('Error aplicando migración de pronosticos flash:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS saldo_disponible INTEGER`);
        await pool.query(`
            UPDATE transacciones
            SET saldo_disponible = saldo_bono
            WHERE saldo_disponible IS NULL AND estado_pago = 'APROBADO'
        `);
    } catch (err) {
        console.error('Error aplicando migración de saldo_disponible:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE pronosticos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
    } catch (err) {
        console.error('Error aplicando migración de created_at en pronosticos:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS redenciones (
                id               SERIAL PRIMARY KEY,
                transaccion_id   INTEGER NOT NULL REFERENCES transacciones(id),
                local_usuario_id INTEGER NOT NULL REFERENCES local_usuarios(id),
                monto            INTEGER NOT NULL,
                saldo_antes      INTEGER NOT NULL,
                saldo_despues    INTEGER NOT NULL,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    } catch (err) {
        console.error('Error creando tabla redenciones:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS compartidas (
                id          SERIAL PRIMARY KEY,
                usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
                partido_id  INTEGER REFERENCES partidos(id),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(usuario_id, partido_id)
            )
        `);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puntos_bonus INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
        console.error('Error aplicando migración de compartidas/puntos_bonus:', err.message);
    }

    // Cuentas de prueba (admin probando el flujo, etc.): se excluyen del ranking
    // global y de los resultados finales, igual que ya se hace con
    // transacciones.es_test para reportes/rankings públicos.
    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS es_test BOOLEAN NOT NULL DEFAULT FALSE`);
    } catch (err) {
        console.error('Error aplicando migración de usuarios.es_test:', err.message);
    }

    // Bonos Especiales para influenciadores/creadores de contenido: cupos +
    // bono real, pero excluidos del ranking de premios y del Bono Colombia.
    try {
        await pool.query(`ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS es_especial BOOLEAN NOT NULL DEFAULT FALSE`);
    } catch (err) {
        console.error('Error aplicando migración de transacciones.es_especial:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE partidos ADD COLUMN IF NOT EXISTS fase TEXT NOT NULL DEFAULT 'grupos' CHECK (fase IN ('grupos','dieciseisavos','octavos','cuartos','semifinal','final'))`);
        await pool.query(`ALTER TABLE pronosticos ADD COLUMN IF NOT EXISTS cupos_costo INTEGER NOT NULL DEFAULT 1`);
    } catch (err) {
        console.error('Error aplicando migración de fase/cupos_costo:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pozo_premios (
                id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                primero     BIGINT NOT NULL DEFAULT 2000000,
                segundo     BIGINT NOT NULL DEFAULT 1000000,
                tercero     BIGINT NOT NULL DEFAULT 500000,
                total_fact  BIGINT NOT NULL DEFAULT 0,
                actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await pool.query(`INSERT INTO pozo_premios DEFAULT VALUES ON CONFLICT DO NOTHING`);
    } catch (err) {
        console.error('Error aplicando migración de pozo_premios:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bonos_colombia (
                id          SERIAL PRIMARY KEY,
                partido_id  INTEGER NOT NULL REFERENCES partidos(id),
                usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
                monto_cop   INTEGER NOT NULL,
                reclamado   BOOLEAN NOT NULL DEFAULT FALSE,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (partido_id, usuario_id)
            )
        `);
    } catch (err) {
        console.error('Error creando tabla bonos_colombia:', err.message);
    }

    // Registro público de influencers/creadores de contenido: solicitud que
    // queda pendiente hasta que el admin les cree manualmente el Bono Especial
    // desde la sección "Influenciadores" del panel.
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS influencer_registros (
                id              SERIAL PRIMARY KEY,
                nombre          VARCHAR(150) NOT NULL,
                correo          VARCHAR(150) NOT NULL,
                celular         VARCHAR(20) NOT NULL,
                red_contenido   VARCHAR(20) NOT NULL CHECK (red_contenido IN ('instagram', 'tiktok', 'ambas')),
                atendido        BOOLEAN NOT NULL DEFAULT FALSE,
                fecha_registro  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        // Foto opcional del influencer (con autorización de uso) para mostrarla
        // en el ranking de creadores de contenido.
        await pool.query(`ALTER TABLE influencer_registros ADD COLUMN IF NOT EXISTS foto_imagen BYTEA`);
        await pool.query(`ALTER TABLE influencer_registros ADD COLUMN IF NOT EXISTS foto_mime TEXT`);
        await pool.query(`ALTER TABLE influencer_registros ADD COLUMN IF NOT EXISTS autoriza_foto BOOLEAN NOT NULL DEFAULT FALSE`);
    } catch (err) {
        console.error('Error creando tabla influencer_registros:', err.message);
    }

    // Foto de perfil (copiada del registro de influencer) y snapshot personal
    // del ranking de creadores de contenido (para detectar cambios de posición
    // desde la última vez que cada influencer lo consultó).
    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_imagen BYTEA`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_mime TEXT`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ranking_snapshot_influencer JSONB`);
    } catch (err) {
        console.error('Error aplicando migración de foto_imagen/ranking_snapshot_influencer:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS codigos_telefono (
                celular         VARCHAR(20) PRIMARY KEY,
                codigo          VARCHAR(6) NOT NULL,
                expira          TIMESTAMPTZ NOT NULL,
                intentos        INTEGER NOT NULL DEFAULT 0,
                registro_token  UUID,
                fecha_creacion  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    } catch (err) {
        console.error('Error creando tabla codigos_telefono:', err.message);
    }

    // Sistema de afiliados/comisiones para influencers: código de afiliado
    // propio (distinto del token_acceso de sesión), registro de clics,
    // comisiones por venta atribuida, y auditoría de eventos de dinero.
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS influencers (
                id                   SERIAL PRIMARY KEY,
                usuario_id           INTEGER NOT NULL UNIQUE REFERENCES usuarios(id),
                codigo_afiliado      VARCHAR(30) UNIQUE NOT NULL,
                porcentaje_comision  NUMERIC(5,2) NOT NULL DEFAULT 10.00,
                activo               BOOLEAN NOT NULL DEFAULT TRUE,
                fecha_creacion       TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS referido_clics (
                id              BIGSERIAL PRIMARY KEY,
                influencer_id   INTEGER NOT NULL REFERENCES influencers(id),
                ip_hash         TEXT NOT NULL,
                user_agent      TEXT,
                utm_source      TEXT,
                utm_medium      TEXT,
                utm_campaign    TEXT,
                valido          BOOLEAN NOT NULL DEFAULT TRUE,
                motivo_invalido TEXT,
                creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_clics_influencer_fecha ON referido_clics(influencer_id, creado_en)');

        await pool.query('ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS influencer_id INTEGER REFERENCES influencers(id)');
        await pool.query('ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS clic_id BIGINT REFERENCES referido_clics(id)');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS comisiones (
                id              SERIAL PRIMARY KEY,
                transaccion_id  INTEGER NOT NULL UNIQUE REFERENCES transacciones(id),
                influencer_id   INTEGER NOT NULL REFERENCES influencers(id),
                monto_venta     INTEGER NOT NULL,
                porcentaje      NUMERIC(5,2) NOT NULL,
                monto_comision  INTEGER NOT NULL,
                estado          VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
                pago_id         INTEGER,
                creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS auditoria_eventos (
                id              BIGSERIAL PRIMARY KEY,
                tabla_afectada  TEXT NOT NULL,
                registro_id     TEXT NOT NULL,
                accion          TEXT NOT NULL,
                actor           TEXT,
                payload_antes   JSONB,
                payload_despues JSONB,
                ip              TEXT,
                creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    } catch (err) {
        console.error('Error aplicando migración del sistema de afiliados/comisiones:', err.message);
    }

    iniciarMonitorPartidos();
    iniciarMonitorMarcadores();
});
