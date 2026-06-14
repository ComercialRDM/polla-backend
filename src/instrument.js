// Sentry debe inicializarse antes de cualquier otro require para poder
// instrumentar automáticamente Express, pg, http, etc.
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
    });
}

module.exports = Sentry;
