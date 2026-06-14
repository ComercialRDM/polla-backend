// Server-Sent Events: notifica a los clientes conectados cuando cambia el
// ranking/marcador de un partido, para evitar polling constante del frontend.

const clientesPorPartido = new Map();

function suscribir(partidoId, res) {
    const id = String(partidoId);
    if (!clientesPorPartido.has(id)) clientesPorPartido.set(id, new Set());
    clientesPorPartido.get(id).add(res);
}

function desuscribir(partidoId, res) {
    const id = String(partidoId);
    const clientes = clientesPorPartido.get(id);
    if (!clientes) return;
    clientes.delete(res);
    if (clientes.size === 0) clientesPorPartido.delete(id);
}

function notificar(partidoId) {
    const id = String(partidoId);
    const clientes = clientesPorPartido.get(id);
    if (!clientes) return;
    for (const res of clientes) {
        res.write('event: actualizado\ndata: {}\n\n');
    }
}

module.exports = { suscribir, desuscribir, notificar };
