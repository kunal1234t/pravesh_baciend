'use strict';

/**
 * exit-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::exit-request.exit-request');
