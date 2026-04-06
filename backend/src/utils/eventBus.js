// SSE Event Bus — broadcast realtime events ke semua client yang terhubung
const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch(e) { clients.delete(client); }
  }
}

function getClientCount() { return clients.size; }

module.exports = { addClient, broadcast, getClientCount };
