const axios = require('axios');

const BASE_URL = 'https://api.football-data.org/v4';
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// GET /competitions/WC/matches - partidos del Mundial (temporada actual)
async function obtenerPartidosMundial() {
    const { data } = await axios.get(`${BASE_URL}/competitions/WC/matches`, {
        headers: { 'X-Auth-Token': TOKEN },
        timeout: 10000,
    });
    return data.matches || [];
}

module.exports = { obtenerPartidosMundial };
