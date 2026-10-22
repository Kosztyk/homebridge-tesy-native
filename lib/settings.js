'use strict';

const PLUGIN_NAME = 'homebridge-tesy-native';
const PLATFORM_NAME = 'TesyNative';
const API_BASE = 'https://ad.mytesy.com/rest';
const ORIGIN = 'https://v4.mytesy.com';
const MQTT_URL = 'wss://mqtt.tesy.com:8083/';
const PRESETS = ['comfort', 'eco', 'sleep'];

function bounded(value, fallback, min, max) {
  const n = value === '' || value === null ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normaliseMac(value) {
  const s = String(value ?? '').trim().replace(/[:-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(s) ? s : '';
}

function configuration(config = {}) {
  if (!config || typeof config !== 'object') config = {};
  const userId = String(config.userId ?? config.user_id ?? '').trim();
  return {
    username: String(config.username ?? '').trim(),
    password: String(config.password ?? ''),
    userId,
    pollInterval: bounded(config.pollInterval, 30, 15, 3600) * 1000,
    requestTimeout: bounded(config.requestTimeout, 8, 3, 15) * 1000,
    offlineAfter: bounded(config.offlineAfter, 300, 60, 3600) * 1000,
    staleHeatingAfter: bounded(config.staleHeatingAfter, 600, 60, 7200) * 1000,
    exposePresets: config.exposePresets !== false,
    debug: config.debug === true,
    devices: (Array.isArray(config.devices) ? config.devices : [])
      .filter(d => d && typeof d === 'object' && normaliseMac(d.mac))
      .map(d => ({
        mac: normaliseMac(d.mac),
        name: typeof d.name === 'string' ? d.name.trim() : undefined,
        exclude: d.exclude === true,
        exposePresets: typeof d.exposePresets === 'boolean' ? d.exposePresets : undefined,
      })),
  };
}

module.exports = { PLUGIN_NAME, PLATFORM_NAME, API_BASE, ORIGIN, MQTT_URL, PRESETS, normaliseMac, configuration };
