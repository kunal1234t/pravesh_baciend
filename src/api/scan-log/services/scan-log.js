'use strict';

/**
 * scan-log service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::scan-log.scan-log');
