'use strict';

const path = require('node:path');
const homebridgeEntry = require.resolve(process.env.TESY_TEST_HOMEBRIDGE_ROOT || 'homebridge');
const { HomebridgeAPI } = require(path.join(path.dirname(homebridgeEntry), 'api.js'));
const { TesyPlatform } = require('../lib/platform');

const ID = 'AABBCCDDEEFF';
const MAC = 'AA:BB:CC:DD:EE:FF';

function snapshot(overrides = {}) {
  return {
    [MAC]: {
      mac: MAC, deviceName: 'Bedroom TESY', model: 'convector', model_type: 'CN 051',
      token: 'private-device-token', firmware_version: '1.2.3',
      state: { status: 'on', heating: 'off', temp: '22', current_temp: '21.5', mode: 'comfort', updated_at: '2026-10-22 12:00:00', ...overrides },
    },
  };
}

function apiAndLog() {
  const api = new HomebridgeAPI();
  api.registrations = [];
  api.removals = [];
  api.updates = [];
  api.registerPlatformAccessories = (plugin, alias, accessories) => api.registrations.push(...accessories);
  api.unregisterPlatformAccessories = (plugin, alias, accessories) => api.removals.push(...accessories);
  api.updatePlatformAccessories = accessories => api.updates.push(...accessories);
  const entries = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => entries.push([level, args.join(' ')])]));
  return { api, log, entries };
}

async function fixture(t, options = {}, state = {}) {
  const { api, log, entries } = apiAndLog();
  const clock = { value: Date.parse('2026-10-22T12:00:00Z') };
  const client = {
    snapshot: snapshot(state), commands: [], gets: 0, closed: false,
    async getDevices() { this.gets++; if (this.error) throw this.error; return structuredClone(this.snapshot); },
    async sendCommand(device, command, payload) {
      if (this.commandError) throw this.commandError;
      this.commands.push({ device, command, payload });
    },
    close() { this.closed = true; },
  };
  const platform = new TesyPlatform(log, { username: 'owner@example.com', password: 'private-password', userId: '12345', ...options }, api, { client, now: () => clock.value });
  t.after(() => platform.stop());
  await platform.refresh();
  return { platform, api, log, entries, clock, client, controller: platform.controllers.get(ID), C: api.hap.Characteristic };
}

module.exports = { ID, MAC, snapshot, apiAndLog, fixture };
