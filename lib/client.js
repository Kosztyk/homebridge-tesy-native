'use strict';

const { randomBytes } = require('node:crypto');
const { API_BASE, ORIGIN, MQTT_URL, PRESETS } = require('./settings');

class TesyError extends Error {
  constructor(message, code = 'CLOUD') {
    super(message);
    this.name = 'TesyError';
    this.code = code;
  }
}

class TesyClient {
  constructor(config, deps = {}) {
    this.config = config;
    this.fetch = deps.fetch || globalThis.fetch;
    this.connect = deps.connect || ((url, options) => require('mqtt').connect(url, options));
    this.appId = randomBytes(8).toString('hex');
    this.mqtt = null;
    this.connecting = null;
    this.closed = false;
    this.requests = new Set();
  }

  async request(path, body) {
    if (this.closed) throw new TesyError('TESY client is shutting down.', 'CLOSED');
    const credentials = {
      userID: this.config.userId, userEmail: this.config.username,
      userPass: this.config.password, lang: 'en',
    };
    const url = new URL(API_BASE + path);
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeout);
    const options = {
      method: body ? 'POST' : 'GET', signal: controller.signal, redirect: 'error',
      headers: { Origin: ORIGIN, Referer: `${ORIGIN}/${body ? 'dashboard' : ''}`, Accept: 'application/json, text/plain, */*' },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ ...body, ...credentials });
    } else {
      url.search = new URLSearchParams(credentials).toString();
    }
    try {
      const response = await this.fetch(url, options);
      if ([401, 403].includes(response.status)) throw new TesyError('MyTESY rejected the account credentials. Check email, password and user ID.', 'AUTH');
      if (!response.ok) throw new TesyError(`MyTESY returned HTTP ${response.status}.`, 'HTTP');
      if (body) {
        // app-log is best effort; drain the response so the connection can be reused.
        await response.text();
        return;
      }
      let data;
      try { data = await response.json(); } catch { throw new TesyError('MyTESY returned an invalid JSON response.', 'FORMAT'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TesyError('MyTESY returned an unexpected device list.', 'FORMAT');
      if (String(data.error) === '1') throw new TesyError('MyTESY rejected the account credentials. Check email, password and user ID.', 'AUTH');
      if ((data.error !== undefined && !['0', '', 'false', 'null'].includes(String(data.error))) || data.errors) {
        throw new TesyError('MyTESY reported an error while fetching the device list.', 'CLOUD');
      }
      return data;
    } catch (error) {
      if (error instanceof TesyError) throw error;
      // Raw fetch/MQTT errors may contain credentials or tokens in URLs/topics.
      if (controller.signal.aborted) throw new TesyError('MyTESY request timed out or was cancelled.', 'TIMEOUT');
      throw new TesyError('Cannot reach MyTESY. Check the internet connection and cloud service.', 'NETWORK');
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  getDevices() { return this.request('/get-my-devices'); }

  ensureMqtt() {
    if (this.closed) return Promise.reject(new TesyError('TESY client is shutting down.', 'CLOSED'));
    if (this.mqtt?.connected) return Promise.resolve(this.mqtt);
    if (this.connecting) return this.connecting;
    if (this.mqtt) this.mqtt.end(true);
    let client;
    try {
      client = this.connect(MQTT_URL, {
        clientId: `hb_tesy_${this.appId}`, username: 'client1', password: '123',
        protocolVersion: 4, keepalive: 20, clean: true, reconnectPeriod: 0,
        connectTimeout: this.config.requestTimeout, queueQoSZero: false, resubscribe: false,
        rejectUnauthorized: true,
        wsOptions: { rejectUnauthorized: true, headers: { Origin: ORIGIN } },
      });
    } catch { return Promise.reject(new TesyError('Cannot create a secure TESY MQTT connection.', 'MQTT')); }
    this.mqtt = client;
    // Always consume async errors, including after an idle connection is lost.
    client.on('error', () => {});
    client.on('close', () => { if (this.mqtt === client) this.mqtt = null; });
    const pending = new Promise((resolve, reject) => {
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        client.removeListener('connect', onConnect);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
        if (error) {
          if (this.mqtt === client) this.mqtt = null;
          client.end(true);
          reject(error);
        } else resolve(client);
      };
      const onConnect = () => finish();
      const onError = () => finish(new TesyError('TESY MQTT connection failed. Check access to mqtt.tesy.com:8083.', 'MQTT'));
      const onClose = () => finish(new TesyError('TESY MQTT connection closed before it was ready.', 'MQTT'));
      const timer = setTimeout(() => finish(new TesyError('TESY MQTT connection timed out.', 'TIMEOUT')), this.config.requestTimeout);
      client.once('connect', onConnect);
      client.once('error', onError);
      client.once('close', onClose);
    });
    this.connecting = pending;
    const clear = () => { if (this.connecting === pending) this.connecting = null; };
    pending.then(clear, clear);
    return pending;
  }

  async sendCommand(device, command, payload) {
    const mac = String(device.mac || device.state?.mac || '').trim();
    const model = String(device.model || '').trim();
    const token = String(device.token || '').trim();
    if ([mac, model, token].some(v => !v || /[\/+#\u0000]/.test(v))) {
      throw new TesyError('This device has no valid MAC, model or control token in MyTESY. Refresh device discovery.', 'DEVICE');
    }
    const valid = (command === 'onOff' && ['on', 'off'].includes(payload.status))
      || (command === 'setTemp' && Number.isInteger(payload.temp) && payload.temp >= 10 && payload.temp <= 30)
      || (command === 'setMode' && [...PRESETS, 'heating'].includes(payload.name));
    if (!valid) throw new TesyError('Unsupported TESY command or value.', 'COMMAND');
    const client = await this.ensureMqtt();
    if (this.closed || !client.connected) throw new TesyError('TESY MQTT is not connected.', 'MQTT');
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        client.removeListener('close', onClose);
        client.removeListener('error', onError);
        if (error) {
          if (this.mqtt === client) this.mqtt = null;
          client.end(true);
          reject(error);
        } else resolve();
      };
      const onClose = () => finish(new TesyError('TESY MQTT disconnected while sending the command.', 'MQTT'));
      const onError = () => finish(new TesyError('TESY MQTT could not send the command.', 'MQTT'));
      const timer = setTimeout(() => finish(new TesyError('TESY command publish timed out.', 'TIMEOUT')), this.config.requestTimeout);
      client.once('close', onClose);
      client.once('error', onError);
      try {
        client.publish(`v1/${mac}/request/${model}/${token}/${command}`,
          JSON.stringify({ app_id: this.appId, ...payload }), { qos: 0, retain: false },
          error => finish(error ? new TesyError('TESY MQTT could not send the command.', 'MQTT') : undefined));
      } catch { finish(new TesyError('TESY MQTT could not send the command.', 'MQTT')); }
    });
    // MQTT publishing is the control path; failure of the app's audit endpoint
    // must not turn a successful publish into a HomeKit error or a retry.
    void this.request('/app-log', { mac, command, payload }).catch(() => {});
  }

  close() {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    if (this.mqtt) this.mqtt.end(true);
    this.mqtt = null;
  }
}

module.exports = { TesyClient, TesyError };
