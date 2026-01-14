'use strict';

/**
 * late-entry-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::late-entry-request.late-entry-request');
