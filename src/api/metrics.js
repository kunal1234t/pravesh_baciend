'use strict';

const client = require('prom-client');

// Keep a dedicated registry so application metrics do not leak into the
// process-global registry or get registered more than once during bootstrap.
const registry = new client.Registry();

client.collectDefaultMetrics({
  register: registry,
  eventLoopMonitoringPrecision: 10,
});

const metrics = {
  qrRedisOperationsTotal: new client.Counter({
    name: 'qr_redis_operations_total',
    help: 'QR-token Redis operations grouped by operation and result.',
    labelNames: ['operation', 'result'],
    registers: [registry],
  }),

  qrRedisFallbackTotal: new client.Counter({
    name: 'qr_redis_fallback_total',
    help: 'QR validations that fell back to the database after a Redis miss.',
    registers: [registry],
  }),

  fcmNotificationsTotal: new client.Counter({
    name: 'fcm_notifications_total',
    help: 'FCM notification send attempts grouped by result.',
    labelNames: ['result'],
    registers: [registry],
  }),

  fcmFailuresTotal: new client.Counter({
    name: 'fcm_failures_total',
    help: 'FCM notification failures grouped by a bounded failure category.',
    labelNames: ['reason'],
    registers: [registry],
  }),

  redisClientConnected: new client.Gauge({
    name: 'redis_client_connected',
    help: 'Whether the shared Redis client is currently ready (1) or not ready (0).',
    registers: [registry],
  }),
};

// Redis has not connected until the shared client emits its ready event.
metrics.redisClientConnected.set(0);

module.exports = {
  client,
  registry,
  metrics,
};
