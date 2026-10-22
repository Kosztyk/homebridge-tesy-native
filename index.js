'use strict';

const { TesyPlatform } = require('./lib/platform');
const { PLUGIN_NAME, PLATFORM_NAME } = require('./lib/settings');

module.exports = api => api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TesyPlatform);
