const crypto = require('crypto');

const targetHash = '4a6820dafa8aef069832a3dc126fe3e08c038375d718b11d83b970d701ed64a0';
const correctToken = '697b92cd5d821c2d8da918e3f81fd069fed2b1f74843eab82f05fd24cde81359';

console.log('Target Hash:', targetHash);

const candidates = [
    '',
    ' ',
    'null',
    'undefined',
    '{}',
    '{"token":null}',
    correctToken,
    `"${correctToken}"`,
    `'${correctToken}'`,
    correctToken.trim(),
    correctToken + '\n',
    JSON.stringify({ token: correctToken }),
];

candidates.forEach(c => {
    const h = crypto.createHash('sha256').update(c).digest('hex');
    if (h === targetHash) {
        console.log('MATCH FOUND! The backend received:', JSON.stringify(c));
    } else {
        // console.log(`No match for: ${JSON.stringify(c)} -> ${h}`);
    }
});
