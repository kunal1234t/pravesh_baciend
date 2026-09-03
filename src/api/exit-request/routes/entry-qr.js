'use strict';

module.exports = {
    routes: [
        {
            method: 'POST',
            // Compatibility alias for clients using the original entry-QR endpoint.
            // Both entry endpoints must use the Redis-backed createEntry handler.
            path: '/exit-requests/entry-qr',
            handler: 'exit-request.createEntry',
            config: {
                auth: {
                    strategies: ['users-permissions'],
                },
            },
        },
    ],
};
