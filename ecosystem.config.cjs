module.exports = {
  apps: [
    {
      name: 'app',
      script: './src/server.js',
      env: {
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true
    }
  ]
};
