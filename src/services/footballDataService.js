const axios = require('axios');

const BASE_URL = 'https://api.football-data.org/v4';
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// GET /competitions/WC/matches - partidos del Mundial (temporada actual)
// Reintenta una vez si hay error de red transitorio o HTTP 5xx de football-data.org
async function obtenerPartidosMundial() {
    const request = () => axios.get(`${BASE_URL}/competitions/WC/matches`, {
        headers: { 'X-Auth-Token': TOKEN },
        timeout: 15000,
    });

    try {
        const { data } = await request();
        return data.matches || [];
    } catch (err) {
        const esErrorRed = err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        const esError5xx = err.response?.status >= 500;
        if (esErrorRed || esError5xx) {
            const espera = esError5xx ? 10000 : 3000;
            console.warn(`footballDataService: error transitorio (${err.code || err.response?.status}), reintentará en ${espera / 1000}s`);
            await new Promise((r) => setTimeout(r, espera));
            const { data } = await request();
            return data.matches || [];
        }
        throw err;
    }
}

module.exports = { obtenerPartidosMundial };
