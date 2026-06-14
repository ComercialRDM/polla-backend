-- ============================================================
-- Polla Mundialista La Retoucherie de Manuela - Esquema DB
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Tabla: usuarios
-- ============================================================
CREATE TABLE IF NOT EXISTS usuarios (
    id              SERIAL PRIMARY KEY,
    nombre          VARCHAR(150) NOT NULL,
    correo          VARCHAR(150) UNIQUE,
    celular         VARCHAR(20) UNIQUE NOT NULL,
    fecha_registro  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Equipos favoritos del usuario (personalización, no obligatorio)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS equipos_favoritos TEXT[] NOT NULL DEFAULT '{}';

-- Cuenta de acceso (celular + contraseña) para el registro general de clientes
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE usuarios ALTER COLUMN correo DROP NOT NULL;

-- Código para reestablecer contraseña (enviado por WhatsApp vía ManyChat)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_code VARCHAR(6);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_code_expira TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_intentos INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- Tabla: partidos
-- ============================================================
CREATE TABLE IF NOT EXISTS partidos (
    id                  SERIAL PRIMARY KEY,
    equipo_local        VARCHAR(100) NOT NULL,
    equipo_visitante    VARCHAR(100) NOT NULL,
    fecha_hora_inicio   TIMESTAMPTZ NOT NULL,
    estado              VARCHAR(20) NOT NULL DEFAULT 'activo'
        CHECK (estado IN ('activo', 'cerrado')),
    goles_local         INTEGER NOT NULL DEFAULT 0,
    goles_visitante     INTEGER NOT NULL DEFAULT 0
);

-- Marcador en vivo: agrega las columnas si la tabla ya existía sin ellas
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS goles_local INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS goles_visitante INTEGER NOT NULL DEFAULT 0;

-- Marca si ya se notificó por WhatsApp a los participantes que el partido comenzó
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS notificado_inicio BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- Tabla: transacciones
-- ============================================================
CREATE TABLE IF NOT EXISTS transacciones (
    id                      SERIAL PRIMARY KEY,
    usuario_id              INTEGER NOT NULL REFERENCES usuarios(id),
    partido_id              INTEGER NOT NULL REFERENCES partidos(id),
    pasarela_transaccion_id VARCHAR(100),
    payment_link_id         VARCHAR(100),
    reference               VARCHAR(150),
    metodo                  VARCHAR(50) NOT NULL DEFAULT 'Wompi',
    valor_pagado            INTEGER NOT NULL,
    saldo_bono              INTEGER NOT NULL DEFAULT 0,
    intentos_totales        INTEGER NOT NULL DEFAULT 0,
    intentos_usados         INTEGER NOT NULL DEFAULT 0,
    estado_pago             VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE'
        CHECK (estado_pago IN ('PENDIENTE', 'APROBADO', 'RECHAZADO')),
    token_acceso            UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    fecha_creacion          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un usuario puede comprar varios bonos para el mismo partido
DROP INDEX IF EXISTS uniq_usuario_partido_activo;

-- Comprobante de pago (foto) para transferencias manuales revisadas por el admin
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS comprobante_imagen BYTEA;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS comprobante_mime VARCHAR(50);

-- Sistema de referidos: token de acceso de quien comparte el link, y si ya se otorgó el bono al referidor
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS referido_por_token UUID;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS referido_bono_otorgado BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- Tabla: pronosticos
-- ============================================================
CREATE TABLE IF NOT EXISTS pronosticos (
    id              SERIAL PRIMARY KEY,
    transaccion_id  INTEGER NOT NULL REFERENCES transacciones(id),
    usuario_id      INTEGER NOT NULL REFERENCES usuarios(id),
    partido_id      INTEGER NOT NULL REFERENCES partidos(id),
    goles_local     INTEGER NOT NULL CHECK (goles_local >= 0),
    goles_visitante INTEGER NOT NULL CHECK (goles_visitante >= 0),
    fecha_registro  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para que el cálculo del ranking en vivo (marcador exacto + desempate por fecha) sea instantáneo
CREATE INDEX IF NOT EXISTS idx_pronosticos_marcador ON pronosticos (partido_id, goles_local, goles_visitante);
CREATE INDEX IF NOT EXISTS idx_pronosticos_fecha_registro ON pronosticos (fecha_registro);

-- ============================================================
-- Datos de ejemplo: partido Colombia vs Brasil (fecha futura UTC)
-- ============================================================
INSERT INTO partidos (equipo_local, equipo_visitante, fecha_hora_inicio, estado)
VALUES ('Colombia', 'Brasil', '2026-06-20 19:00:00+00', 'activo')
ON CONFLICT DO NOTHING;
