const crypto = require('crypto');

const rawToken = '697b92cd5d821c2d8da918e3f81fd069fed2b1f74843eab82f05fd24cde81359';
const expectedHashInValidate = '4a6820dafa8aef069832a3dc126fe3e08c038375d718b11d83b970d701ed64a0';

const calculatedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

console.log('Raw Token:', rawToken);
console.log('Calculated Hash:', calculatedHash);
console.log('Expected Hash (from validate logs):', expectedHashInValidate);
console.log('Match?', calculatedHash === expectedHashInValidate);

const existingHashes = [
    '641b164e139864d53653229868c1dc723b174186ae7b9c8506bbc1d6ad6a1c36',
    'c63223c71c9b29c9afc63d821f361f87f08bfa4d0396963104183bd385ed9576',
    '5b7c0405e7cd51cc84e1510173c14837ea20bd6ddb8a2589ed637f9c85eb4e0f',
    '22ada38c15139d8e6d1e1917ae603d4ac12b36f3ab5b77368717b6c1d5b232f6',
    'b300d81b378fd566d04fa5173c711e19b85979415c18a2faa7a0415396df0af5',
    '243266ddec41aa9d88e1edc4ffe1cb8b592b4a3d14be0a0d33757784726928d3',
    'e8da5d9ecb83375032df559b2e9bf5b5d51ae4a321a5b4a9c2919da113a2a45b',
    '42444788c5814b5234d9f8cb7567faec38eb5e9e66468554c807b32c07a66467'
];

const foundInDb = existingHashes.includes(calculatedHash);
console.log('Found in DB list?', foundInDb);
