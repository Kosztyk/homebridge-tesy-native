'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, normaliseMac } = require('../lib/settings');
const { finiteNumber, derivedState, timestamp, normaliseDevices } = require('../lib/state');
const { snapshot, ID, MAC } = require('./helpers');
const now = Date.parse('2026-10-22T12:00:00Z');

test('blank device overrides never prevent automatic discovery', () => {
  const config = configuration({ devices: [{ exclude: false }, {}, null, { mac: 'aa-bb-cc-dd-ee-ff', name: 'Heater' }] });
  assert.equal(config.devices.length, 1);
  assert.equal(config.devices[0].mac, ID);
  assert.equal(config.pollInterval, 30000);
  assert.equal(configuration({ user_id: 123 }).userId, '123');
  assert.equal(configuration({ pollInterval: 0, requestTimeout: 'bad' }).pollInterval, 15000);
  assert.equal(normaliseMac('metadata'), '');
});

test('unknown temperatures remain unknown rather than turning into 0 °C', () => {
  for (const value of [null, undefined, '', ' ', false, true, 'NaN', 'unavailable', Infinity]) assert.equal(finiteNumber(value), undefined);
  assert.equal(finiteNumber('21.5'), 21.5);
  assert.equal(finiteNumber(0), 0);
});

test('stale idle and off timestamps do not disconnect healthy convectors', () => {
  const idle = derivedState({ status: 'on', heating: 'off', updated_at: '2020-01-01 00:00:00', mode: 'eco' }, now, 600000);
  assert.deepEqual(idle, { on: true, heating: false, staleHeating: false });
  assert.equal(derivedState({ status: 'off', mode: 'comfort' }, now, 600000).on, false);
});

test('stale active heating is suppressed just as in the HA integration', () => {
  assert.deepEqual(derivedState({ status: 'on', heating: 'on', updated_at: '2026-10-22 11:00:00' }, now, 600000), { on: false, heating: false, staleHeating: true });
  assert.equal(derivedState({ status: 'off', heating: 'on', updated_at: '2026-10-22 12:00:00' }, now, 600000).on, true);
});

test('cloud timestamps without an offset are parsed as UTC', () => {
  assert.equal(timestamp('2026-10-22 12:00:00'), now);
  assert.equal(timestamp('2026-10-22T15:00:00+03:00'), now);
  assert.equal(timestamp('not a timestamp'), undefined);
});

test('only compatible convector snapshots become thermostat accessories', () => {
  const raw = snapshot();
  delete raw[MAC].mac;
  raw.error = '0';
  raw.metadata = { state: {} };
  raw['11:22:33:44:55:66'] = { type: 'boiler', state: { status: 'on', temp: 60, current_temp: 50 } };
  raw['11:22:33:44:55:77'] = { state: { power_status: 'on', temp: 22, current_temp: 21 } };
  const records = normaliseDevices(raw);
  assert.equal(records.size, 1);
  assert.equal(records.get(ID).device.mac, MAC);
});
