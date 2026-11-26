const http = require('node:http');

// A server for supertest bound to the loopback address. When supertest is given an app it
// opens a wildcard-address server per request, and on macOS that can receive a port number
// another local listener already holds on 127.0.0.1: the request then reaches that listener.
async function loopbackServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

module.exports = { closeServer, loopbackServer };
