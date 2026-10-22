'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const mqttPacket = require('mqtt-packet');
const mqtt = require('mqtt');
const { TesyClient } = require('../lib/client');
const { configuration } = require('../lib/settings');
const { snapshot, MAC } = require('./helpers');

test('real MQTT.js sends the expected MQTT 3.1.1 packets over WebSocket', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const received = [];
  let gotPublish;
  const published = new Promise(resolve => { gotPublish = resolve; });
  server.on('connection', ws => {
    const parser = mqttPacket.parser();
    ws.on('message', data => parser.parse(data));
    parser.on('packet', packet => {
      received.push(packet);
      if (packet.cmd === 'connect') ws.send(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }));
      if (packet.cmd === 'pingreq') ws.send(mqttPacket.generate({ cmd: 'pingresp' }));
      if (packet.cmd === 'publish') gotPublish(packet);
    });
  });
  const config = configuration({ username: 'test@example.com', password: 'test-password', userId: '123' });
  const client = new TesyClient(config, {
    connect: (url, options) => mqtt.connect(`ws://127.0.0.1:${server.address().port}/`, options),
    fetch: async () => new Response('{}'),
  });
  t.after(async () => {
    client.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await client.sendCommand(snapshot()[MAC], 'onOff', { status: 'on' });
  const packet = await published;
  assert.equal(received[0].protocolVersion, 4);
  assert.equal(received[0].username, 'client1');
  assert.equal(received[0].password.toString(), '123');
  assert.equal(packet.topic, `v1/${MAC}/request/convector/private-device-token/onOff`);
  assert.deepEqual(JSON.parse(packet.payload.toString()), { app_id: client.appId, status: 'on' });
  assert.equal(packet.qos, 0);
  assert.equal(packet.retain, false);
  assert.equal(received.some(p => p.cmd === 'subscribe'), false);
});
