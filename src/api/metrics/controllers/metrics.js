'use strict';

const { registry } = require('../../metrics');

module.exports = {
  async getMetrics(ctx) {
    ctx.set('Content-Type', registry.contentType);
    ctx.body = await registry.metrics();
  },
};
