// Mapea los nombres en español usados en nuestra base de datos a los nombres
// (en inglés) que devuelve football-data.org para cada selección del Mundial 2026.
const NOMBRES_EQUIVALENTES = {
    Mexico: ['Mexico'],
    Sudafrica: ['South Africa'],
    'Corea del Sur': ['Korea Republic', 'South Korea', 'Korea, South'],
    Chequia: ['Czech Republic', 'Czechia'],
    Canada: ['Canada'],
    'Bosnia y Herzegovina': ['Bosnia and Herzegovina', 'Bosnia-Herzegovina'],
    'Estados Unidos': ['United States', 'USA'],
    Paraguay: ['Paraguay'],
    Brasil: ['Brazil'],
    Marruecos: ['Morocco'],
    Haiti: ['Haiti'],
    Escocia: ['Scotland'],
    Australia: ['Australia'],
    Turquia: ['Turkey', 'Türkiye', 'Turkiye'],
    Alemania: ['Germany'],
    Curazao: ['Curaçao', 'Curacao'],
    Holanda: ['Netherlands'],
    Japon: ['Japan'],
    'Costa de Marfil': ['Ivory Coast', "Côte d'Ivoire", "Cote d'Ivoire"],
    Ecuador: ['Ecuador'],
    Tunez: ['Tunisia'],
    Suecia: ['Sweden'],
    Espana: ['Spain'],
    'Cabo Verde': ['Cape Verde', 'Cabo Verde', 'Cape Verde Islands'],
    Belgica: ['Belgium'],
    Egipto: ['Egypt'],
    'Arabia Saudita': ['Saudi Arabia'],
    Uruguay: ['Uruguay'],
    Iran: ['Iran', 'IR Iran', 'Islamic Republic of Iran'],
    'Nueva Zelanda': ['New Zealand'],
    Francia: ['France'],
    Senegal: ['Senegal'],
    Irak: ['Iraq'],
    Noruega: ['Norway'],
    Argentina: ['Argentina'],
    Argelia: ['Algeria'],
    Austria: ['Austria'],
    Jordania: ['Jordan'],
    Portugal: ['Portugal'],
    'RD Congo': ['DR Congo', 'Congo DR', 'Democratic Republic of the Congo'],
    Inglaterra: ['England'],
    Croacia: ['Croatia'],
    Ghana: ['Ghana'],
    Panama: ['Panama'],
    Uzbekistan: ['Uzbekistan'],
    Colombia: ['Colombia'],
    Suiza: ['Switzerland'],
    Catar: ['Qatar'],
};

function normalizar(texto) {
    return String(texto)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim();
}

// Compara el nombre de un equipo en nuestra BD con el nombre devuelto por la API
function coincideEquipo(nombreLocal, nombreApi) {
    if (!nombreApi) return false;
    const candidatos = NOMBRES_EQUIVALENTES[nombreLocal] || [nombreLocal];
    const apiNorm = normalizar(nombreApi);
    return candidatos.some((candidato) => normalizar(candidato) === apiNorm);
}

// Índice inverso (se construye una sola vez): nombre normalizado de la API -> nombre en español
const NOMBRE_ESPANOL_POR_API = {};
for (const [nombreEspanol, alias] of Object.entries(NOMBRES_EQUIVALENTES)) {
    for (const nombreApi of alias) {
        NOMBRE_ESPANOL_POR_API[normalizar(nombreApi)] = nombreEspanol;
    }
}

// Traduce el nombre de un equipo devuelto por football-data.org a nuestro
// nombre en español. Si no hay equivalencia conocida, devuelve el nombre de
// la API tal cual (mejor mostrar el nombre en inglés que perder el partido).
function nombreEspanol(nombreApi) {
    if (!nombreApi) return nombreApi;
    return NOMBRE_ESPANOL_POR_API[normalizar(nombreApi)] || nombreApi;
}

module.exports = { coincideEquipo, nombreEspanol };
