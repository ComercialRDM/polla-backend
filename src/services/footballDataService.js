const axios = require('axios');

const BASE_URL = 'https://api.football-data.org/v4';
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// GET /competitions/WC/matches - partidos del Mundial (temporada actual)
// Reintenta una vez si hay error de red transitorio (ECONNRESET / TLS)
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
        if (esErrorRed) {
            await new Promise((r) => setTimeout(r, 3000));
            const { data } = await request();
            return data.matches || [];
        }
        throw err;
    }
}

module.exports = { obtenerPartidosMundial };
