const custom = require('./custom-visitor');
const warden = require('./warden-visitor');

module.exports = {
  routes: [...custom.routes, ...warden.routes],
};
