const config = require('./config');
const { getDb } = require('./db');
const { createApp } = require('./app');

getDb();

const app = createApp();
app.listen(config.port, () => {
  console.log(`IETI Agents DeepSeek proxy listening on http://localhost:${config.port}`);
});
