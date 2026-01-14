'use strict';

/**
 * qr-token service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::qr-token.qr-token');
