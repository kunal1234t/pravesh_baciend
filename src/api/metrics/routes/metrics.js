module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/metrics',
      handler: 'metrics.getMetrics',
      config: {
        auth: false, // Public endpoint
      },
    },
  ],
};
