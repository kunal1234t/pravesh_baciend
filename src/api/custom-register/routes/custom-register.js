'use strict';

module.exports = {
    routes: [
        {
            method: 'POST',
            path: '/custom-register',
            handler: 'custom-register.register',
            config: {
                auth: false,
            },
            type: 'content-api', // 🔴 THIS IS REQUIRED IN STRAPI v5
        },
    ],
};
