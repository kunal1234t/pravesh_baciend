'use strict';

/**
 * scan-log router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::scan-log.scan-log');
