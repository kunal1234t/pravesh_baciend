const http = require('http');

// ---------------------------------------------------------
// PASTE YOUR TOKEN HERE FROM FLUTTER LOGS OR STRAPI ADMIN
// Example: "a1b2c3d4..."
const QR_TOKEN = "PASTE_YOUR_TOKEN_HERE";
// ---------------------------------------------------------

const data = JSON.stringify({
    token: QR_TOKEN
});

const options = {
    hostname: 'localhost',
    port: 1337,
    path: '/api/qr-token/validate',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = http.request(options, res => {
    console.log(`Status Code: ${res.statusCode}`);

    res.on('data', d => {
        process.stdout.write(d);
    });
});

req.on('error', error => {
    console.error('Error:', error);
});

req.write(data);
req.end();
