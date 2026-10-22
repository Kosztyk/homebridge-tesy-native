'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TesyPlatform } = require('../lib/platform');
const { TesyError } = require('../lib/client');
const { fixture, apiAndLog, ID, MAC } = require('./helpers');

test('plugin registers the platform alias used by its configuration schema', () => {
  let registration;
  require('../index')({ registerPlatform: (...args) => { registration = args; } });
  assert.deepEqual(registration.slice(0, 2), ['homebridge-tesy-native', 'TesyNative']);
  assert.equal(registration[2], TesyPlatform);
});

test('real Homebridge thermostat exposes only Heat/Off and a 10–30 °C integer setpoint', async t => {
  const { api, controller, C, client } = await fixture(t, { devices: [{ exclude: false }] });
  assert.equal(api.registrations.length, 1);
  assert.equal(controller.thermostat.UUID, api.hap.Service.Thermostat.UUID);
  assert.deepEqual(controller.thermostat.getCharacteristic(C.TargetHeatingCoolingState).props.validValues, [0, 1]);
  assert.equal(controller.thermostat.getCharacteristic(C.TargetTemperature).props.minStep, 1);
  assert.equal(controller.thermostat.getCharacteristic(C.TargetTemperature).props.maxValue, 30);
  assert.equal(await controller.thermostat.getCharacteristic(C.CurrentTemperature).handleGetRequest(), 21.5);
  assert.equal(client.gets, 1, 'HomeKit reads must not start extra cloud requests');
});

test('HomeKit setters send exact source protocol commands and leave power unchanged on temperature writes', async t => {
  const { controller, C, client } = await fixture(t);
  await controller.thermostat.getCharacteristic(C.TargetTemperature).handleSetRequest(24);
  assert.equal(controller.readTargetTemperature(), 24);
  await controller.thermostat.getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.OFF);
  assert.equal(controller.readTargetMode(), C.TargetHeatingCoolingState.OFF);
  assert.deepEqual(client.commands.map(({ command, payload }) => ({ command, payload })), [
    { command: 'setTemp', payload: { temp: 24 } }, { command: 'onOff', payload: { status: 'off' } },
  ]);
  await assert.rejects(controller.setTemperature(60));
  await assert.rejects(controller.setPower(C.TargetHeatingCoolingState.COOL));
  assert.equal(client.commands.length, 2);
});

test('presets stay mutually exclusive; disabling the selected preset returns to manual mode', async t => {
  const { controller, client } = await fixture(t);
  await controller.setPreset('eco', true);
  assert.equal(controller.readPreset('eco'), true);
  assert.equal(controller.readPreset('comfort'), false);
  await controller.setPreset('comfort', false);
  assert.equal(client.commands.length, 1, 'turning off an inactive preset must not send a command');
  await controller.setPreset('eco', false);
  assert.deepEqual(client.commands.map(c => c.payload), [{ name: 'eco' }, { name: 'heating' }]);
  assert.equal(controller.readTargetMode(), 1, 'preset switching must not turn power off');
});

test('Heat commands preserve observed active heating without inventing new activity', async t => {
  const active = await fixture(t, {}, { heating: 'on' });
  await active.controller.setPower(active.C.TargetHeatingCoolingState.HEAT);
  assert.equal(active.controller.readCurrentMode(), active.C.CurrentHeatingCoolingState.HEAT);
  const idle = await fixture(t, {}, { status: 'off', heating: 'off' });
  await idle.controller.setPower(idle.C.TargetHeatingCoolingState.HEAT);
  assert.equal(idle.controller.readTargetMode(), idle.C.TargetHeatingCoolingState.HEAT);
  assert.equal(idle.controller.readCurrentMode(), idle.C.CurrentHeatingCoolingState.OFF);
});

test('failed commands keep reported state and return a HomeKit communication failure', async t => {
  const { controller, client, api } = await fixture(t);
  client.commandError = new TesyError('Test transport error', 'MQTT');
  await assert.rejects(controller.setTemperature(26), e => e.hapStatus === api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(controller.readTargetTemperature(), 22);
  assert.equal(controller.pending.size, 0);
});

test('old cloud snapshots cannot immediately undo a successful write; unconfirmed writes expire', async t => {
  const { platform, controller, clock, client, entries } = await fixture(t);
  await controller.setTemperature(25);
  await platform.refresh();
  assert.equal(controller.readTargetTemperature(), 25);
  clock.value += 16000;
  await platform.refresh();
  assert.equal(controller.readTargetTemperature(), 22);
  assert.ok(entries.some(([, s]) => s.includes('Cloud has not confirmed temp')));
  await controller.setTemperature(24);
  client.snapshot[MAC].state.temp = '24';
  await platform.refresh();
  assert.equal(controller.pending.has('temp'), false);
});

test('short cloud failures preserve availability, a sustained outage fails reads, and recovery works', async t => {
  const { platform, controller, client, clock } = await fixture(t);
  client.error = new TesyError('Network unavailable', 'NETWORK');
  clock.value += 30000;
  await platform.refresh();
  assert.equal(controller.readCurrentTemperature(), 21.5);
  clock.value += 301000;
  await platform.refresh();
  assert.throws(() => controller.readCurrentTemperature());
  delete client.error;
  await platform.refresh();
  assert.equal(controller.readCurrentTemperature(), 21.5);
});

test('missing devices retain stable accessories but expire instead of claiming fresh data', async t => {
  const { platform, client, clock, controller, api } = await fixture(t);
  client.snapshot = {};
  await platform.refresh();
  assert.equal(controller.available(), true);
  clock.value += 301000;
  await platform.refresh();
  assert.equal(controller.available(), false);
  assert.equal(api.removals.length, 0);
  assert.equal(api.registrations.length, 1);
});

test('stale idle devices remain available while stale active heating stops showing Heat', async t => {
  const { platform, client, clock, controller } = await fixture(t, {}, { updated_at: '2020-01-01 00:00:00' });
  assert.equal(controller.readTargetMode(), 1);
  assert.equal(controller.available(), true);
  client.snapshot[MAC].state.heating = 'on';
  await platform.refresh();
  assert.equal(controller.readTargetMode(), 0);
  client.snapshot[MAC].state.updated_at = new Date(clock.value).toISOString();
  await platform.refresh();
  assert.equal(controller.readCurrentMode(), 1);
});

test('null temperature readings fail safely rather than becoming zero', async t => {
  const { controller } = await fixture(t, {}, { current_temp: null });
  assert.throws(() => controller.readCurrentTemperature());
});

test('cache restore preserves UUID and metadata without persisting passwords or control tokens', async t => {
  const { platform, api, client } = await fixture(t);
  const oldAccessory = api.registrations[0];
  const serialised = JSON.stringify(oldAccessory.context);
  assert.ok(!serialised.includes('private-password'));
  assert.ok(!serialised.includes('private-device-token'));
  const { api: api2, log } = apiAndLog();
  const restored = new api2.platformAccessory(oldAccessory.displayName, oldAccessory.UUID);
  restored.context = JSON.parse(serialised);
  const second = new TesyPlatform(log, { username: 'owner@example.com', password: 'private-password', userId: '12345' }, api2, { client, now: platform.now });
  t.after(() => second.stop());
  second.configureAccessory(restored);
  assert.throws(() => second.controllers.get(ID).readTargetTemperature(), 'cached readings are not treated as live on startup');
  await second.refresh();
  assert.equal(api2.registrations.length, 0);
  assert.equal(second.cached.get(ID).UUID, oldAccessory.UUID);
  assert.equal(second.controllers.get(ID).readTargetTemperature(), 22);
});

test('exclusions apply by exact MAC and per-device preset overrides work', async t => {
  const { platform, api } = await fixture(t, { devices: [{ mac: MAC, exclude: true }] });
  assert.equal(api.registrations.length, 0);
  assert.equal(platform.controllers.size, 0);
  const other = await fixture(t, { devices: [{ mac: MAC, name: 'Office heater', exposePresets: false }] });
  assert.equal(other.controller.name, 'Office heater');
  assert.equal(other.controller.presets.size, 0);
});

test('concurrent refreshes share one HTTP request', async t => {
  const { platform, client } = await fixture(t);
  let resolve;
  client.getDevices = () => new Promise(r => { resolve = r; });
  const a = platform.refresh();
  const b = platform.refresh();
  assert.equal(a, b);
  resolve(client.snapshot);
  assert.equal(await a, true);
});

test('rapid writes are ordered and use the newest control token', async t => {
  const { platform, controller, client } = await fixture(t);
  let firstDone;
  let calls = 0;
  const sent = [];
  client.sendCommand = async (device, cmd, payload) => {
    sent.push({ token: device.token, payload });
    if (++calls === 1) await new Promise(r => { firstDone = r; });
  };
  const a = controller.setTemperature(23);
  const b = controller.setTemperature(25);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  client.snapshot[MAC].token = 'refreshed-private-token';
  await platform.refresh();
  firstDone();
  await Promise.all([a, b]);
  assert.deepEqual(sent.map(s => s.payload.temp), [23, 25]);
  assert.equal(sent[1].token, 'refreshed-private-token');
  assert.equal(controller.readTargetTemperature(), 25);
});
