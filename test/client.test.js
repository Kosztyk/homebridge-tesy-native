'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TesyClient, TesyError } = require('../lib/client');
const { configuration, MQTT_URL } = require('../lib/settings');
const { snapshot, MAC } = require('./helpers');

const config = () => configuration({ username: 'account@example.com', password: 'secret + & password', userId: '12345' });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function broker(options = {}) {
  const calls = [];
  const connect = (url, config) => {
    const client = new EventEmitter();
    client.connected = false;
    client.published = [];
    client.end = () => { client.connected = false; queueMicrotask(() => client.emit('close')); };
    client.publish = (topic, body, opts, cb) => {
      client.published.push({ topic, body, opts });
      if (options.publishHang) return;
      queueMicrotask(() => cb(options.publishError ? Error('unsafe-secret-in-topic') : undefined));
    };
    calls.push({ url, config, client });
    if (!options.connectHang) queueMicrotask(() => {
      if (options.connectError) client.emit('error', Error('unsafe-secret-in-url'));
      else { client.connected = true; client.emit('connect'); }
    });
    return client;
  };
  return { calls, connect };
}

test('device discovery follows the supplied integration API and preserves credentials exactly', async t => {
  let seen;
  const client = new TesyClient(config(), { fetch: async (url, options) => { seen = { url, options }; return response(snapshot()); } });
  t.after(() => client.close());
  await client.getDevices();
  assert.equal(seen.url.origin + seen.url.pathname, 'https://ad.mytesy.com/rest/get-my-devices');
  assert.equal(seen.url.searchParams.get('userPass'), config().password);
  assert.equal(seen.url.searchParams.get('userID'), '12345');
  assert.equal(seen.options.headers.Origin, 'https://v4.mytesy.com');
  assert.equal(seen.options.redirect, 'error');
});

test('authentication, HTTP and malformed responses are detected safely', async t => {
  for (const [data, status, code] of [[{ error: '1' }, 200, 'AUTH'], [{ error: 1 }, 200, 'AUTH'], [{}, 401, 'AUTH'], [{}, 503, 'HTTP'], [[], 200, 'FORMAT']]) {
    const client = new TesyClient(config(), { fetch: async () => response(data, status) });
    t.after(() => client.close());
    await assert.rejects(client.getDevices(), e => e instanceof TesyError && e.code === code && !e.message.includes('secret'));
  }
  const client = new TesyClient(config(), { fetch: async () => { throw Error('https://user:secret@example.com/?userPass=private'); } });
  await assert.rejects(client.getDevices(), e => e.code === 'NETWORK' && !e.message.includes('private'));
});

test('MQTT uses exact unretained QoS 0 command topics and a reusable secure connection', async t => {
  const mqtt = broker();
  const posts = [];
  const client = new TesyClient(config(), { connect: mqtt.connect, fetch: async (url, options) => { posts.push(JSON.parse(options.body)); return response({}); } });
  t.after(() => client.close());
  const device = snapshot()[MAC];
  await client.sendCommand(device, 'onOff', { status: 'on' });
  await client.sendCommand(device, 'setTemp', { temp: 23 });
  await client.sendCommand(device, 'setMode', { name: 'eco' });
  assert.equal(mqtt.calls.length, 1);
  const { url, config: opts, client: connection } = mqtt.calls[0];
  assert.equal(url, MQTT_URL);
  assert.equal(opts.protocolVersion, 4);
  assert.equal(opts.reconnectPeriod, 0);
  assert.equal(opts.queueQoSZero, false);
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.wsOptions.rejectUnauthorized, true);
  assert.deepEqual(connection.published.map(p => p.topic), ['onOff', 'setTemp', 'setMode'].map(cmd => `v1/${MAC}/request/convector/private-device-token/${cmd}`));
  assert.deepEqual(JSON.parse(connection.published[1].body), { app_id: client.appId, temp: 23 });
  for (const p of connection.published) assert.deepEqual(p.opts, { qos: 0, retain: false });
  assert.equal(posts[0].userPass, config().password);
  assert.equal(posts[0].command, 'onOff');
});

test('simultaneous connection requests share one handshake', async t => {
  const mqtt = broker();
  const client = new TesyClient(config(), { connect: mqtt.connect });
  t.after(() => client.close());
  const [a, b] = await Promise.all([client.ensureMqtt(), client.ensureMqtt()]);
  assert.equal(a, b);
  assert.equal(mqtt.calls.length, 1);
});

test('failed app-log does not replay or fail a successfully published command', async t => {
  const mqtt = broker();
  const client = new TesyClient(config(), { connect: mqtt.connect, fetch: async () => { throw Error('audit service unavailable'); } });
  t.after(() => client.close());
  await client.sendCommand(snapshot()[MAC], 'onOff', { status: 'off' });
  assert.equal(mqtt.calls[0].client.published.length, 1);
});

test('disconnects, connection refusal and publish errors reject commands without exposing tokens', async t => {
  for (const opts of [{ connectError: true }, { publishError: true }]) {
    const mqtt = broker(opts);
    const client = new TesyClient(config(), { connect: mqtt.connect });
    t.after(() => client.close());
    await assert.rejects(client.sendCommand(snapshot()[MAC], 'onOff', { status: 'on' }), e => e.code === 'MQTT' && !e.message.includes('unsafe-secret'));
  }
  const mqtt = broker({ publishHang: true });
  const client = new TesyClient(config(), { connect: mqtt.connect });
  t.after(() => client.close());
  const pending = client.sendCommand(snapshot()[MAC], 'onOff', { status: 'on' });
  await new Promise(resolve => setImmediate(resolve));
  mqtt.calls[0].client.emit('close');
  await assert.rejects(pending, e => e.code === 'MQTT');
});

test('timed-out commands are terminated rather than queued for a later reconnect', async t => {
  const mqtt = broker({ publishHang: true });
  const client = new TesyClient({ ...config(), requestTimeout: 20 }, { connect: mqtt.connect });
  t.after(() => client.close());
  await assert.rejects(client.sendCommand(snapshot()[MAC], 'onOff', { status: 'on' }), e => e.code === 'TIMEOUT');
  assert.equal(client.mqtt, null);
  assert.equal(mqtt.calls[0].client.connected, false);
});

test('missing control metadata and out-of-range values never reach MQTT', async () => {
  const mqtt = broker();
  const client = new TesyClient(config(), { connect: mqtt.connect });
  await assert.rejects(client.sendCommand({ mac: MAC, model: 'convector' }, 'onOff', { status: 'on' }), e => e.code === 'DEVICE');
  await assert.rejects(client.sendCommand(snapshot()[MAC], 'setTemp', { temp: 60 }), e => e.code === 'COMMAND');
  assert.equal(mqtt.calls.length, 0);
  client.close();
});
