const config = require('./config');
const { getDb } = require('./db');
const { createApp } = require('./app');
const { createProviderKeepWarmService } = require('./services/providerKeepWarmService');

getDb();

const app = createApp();
const keepWarm = createProviderKeepWarmService();
const server = app.listen(config.port, () => {
  console.log(`IETI Agents proxy listening on http://localhost:${config.port}`);
  keepWarm.start();
});
server.once('close', () => keepWarm.stop());
