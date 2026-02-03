'use strict';

module.exports = {
    routes: [
        {
            method: 'POST',
            path: '/exit-requests/entry-qr', // Updated path to distinguish from previous attempts
            handler: 'api::exit-request.entry-qr.createEntryQR', // Reference the new controller file with GLOBAL ID
            config: {
                auth: {
                    strategies: ['users-permissions'],
                },
            },
        },
    ],
};
