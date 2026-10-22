'use strict';

const { TesyClient, TesyError } = require('./client');
const { TesyAccessory } = require('./accessory');
const { PLUGIN_NAME, PLATFORM_NAME, configuration, normaliseMac } = require('./settings');
const { normaliseDevices } = require('./state');

class TesyPlatform {
  constructor(log, config, api, deps = {}) {
    this.log = log;
    this.api = api;
    this.config = configuration(config);
    this.now = deps.now || Date.now;
    this.client = deps.client || new TesyClient(this.config);
    this.cached = new Map();
    this.controllers = new Map();
    this.commandTimers = new Set();
    this.refreshing = null;
    this.stopped = false;
    this.launched = false;
    this.lastError = null;
    this.lastCount = null;
    api.on('didFinishLaunching', () => { void this.start(); });
    api.on('shutdown', () => this.stop());
  }

  override(id) { return this.config.devices.find(d => d.mac === id) || {}; }

  configureAccessory(accessory) {
    const metadata = accessory.context.tesy;
    const id = normaliseMac(metadata?.mac || metadata?.id);
    if (!id) {
      this.log.warn(`Ignoring a TESY cache entry with no device ID: ${accessory.displayName}`);
      return;
    }
    this.cached.set(id, accessory);
    if (this.override(id).exclude === true) return;
    const meta = { ...metadata, id, name: this.override(id).name?.trim() || metadata.name || accessory.displayName };
    this.controllers.set(id, new TesyAccessory(this, accessory, meta, this.override(id)));
  }

  async start() {
    if (this.launched || this.stopped) return;
    this.launched = true;
    for (const id of this.cached.keys()) if (this.override(id).exclude === true) this.removeExcluded(id);
    if (!this.config.username || !this.config.password || !this.config.userId) {
      this.log.error('Enter the MyTESY email, password and user ID in the TESY Native settings, then restart Homebridge.');
      return;
    }
    const tick = async () => {
      await this.refresh();
      if (this.stopped) return;
      const delay = this.lastError === 'AUTH' ? Math.max(60000, this.config.pollInterval) : this.config.pollInterval;
      this.pollTimer = setTimeout(() => { void tick(); }, delay);
      this.pollTimer.unref?.();
    };
    await tick();
  }

  removeExcluded(id) {
    const accessory = this.cached.get(id);
    if (accessory) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Excluded device: ${accessory.displayName}`);
    }
    this.controllers.delete(id);
    this.cached.delete(id);
  }

  refresh() {
    if (this.stopped) return Promise.resolve(false);
    if (this.refreshing) return this.refreshing;
    const task = this.refreshOnce();
    this.refreshing = task;
    const clear = () => { if (this.refreshing === task) this.refreshing = null; };
    task.then(clear, clear);
    return task;
  }

  async refreshOnce() {
    try {
      const raw = await this.client.getDevices();
      if (this.stopped) return false;
      const records = normaliseDevices(raw);
      const now = this.now();
      const seen = new Set();
      for (const [id, record] of records) {
        const options = this.override(id);
        if (options.exclude === true) { this.removeExcluded(id); continue; }
        seen.add(id);
        const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim() : record.name;
        const metadata = {
          id, mac: record.mac, name,
          model: String(record.device.model_type || record.device.model || 'Cloud Convector'),
          firmware: String(record.device.firmware_version || 'Unknown'),
        };
        let accessory = this.cached.get(id);
        const fresh = !accessory;
        if (fresh) {
          accessory = new this.api.platformAccessory(name, this.api.hap.uuid.generate(`tesy:${id}`), this.api.hap.Categories.THERMOSTAT);
          this.cached.set(id, accessory);
        }
        let controller = this.controllers.get(id);
        const changed = JSON.stringify(accessory.context.tesy) !== JSON.stringify(metadata);
        // Only persist safe identity fields. Cloud tokens and account credentials
        // stay in memory and never enter Homebridge's accessory cache.
        accessory.context.tesy = metadata;
        if (!controller) {
          controller = new TesyAccessory(this, accessory, metadata, options);
          this.controllers.set(id, controller);
        } else if (changed) {
          controller.name = name;
          controller.configure(metadata);
        }
        controller.update(record, now);
        if (fresh) {
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.log.info(`Added TESY thermostat: ${name} (${record.mac}, ${metadata.model})`);
        } else if (changed) this.api.updatePlatformAccessories([accessory]);
        if (this.config.debug) this.log.info(`[${name}] Temperature ${record.state.current_temp} °C, target ${record.state.temp} °C, status ${record.state.status}, heating ${record.state.heating}, mode ${record.state.mode}.`);
      }
      for (const [id, controller] of this.controllers) if (!seen.has(id)) controller.updateValues();
      if (this.lastError) this.log.info('MyTESY cloud connection recovered.');
      this.lastError = null;
      if (this.lastCount !== seen.size) {
        if (seen.size === 0) this.log.warn('No compatible MyTESY convectors found. Check the account, user ID and device exclusions. Legacy TESY Cloud devices and water heaters use another protocol.');
        else this.log.info(`Found ${seen.size} TESY convector${seen.size === 1 ? '' : 's'}.`);
        this.lastCount = seen.size;
      }
      return true;
    } catch (error) {
      const code = error instanceof TesyError ? error.code : 'INTERNAL';
      if (this.lastError !== code) {
        this.log.warn(`TESY refresh failed: ${error instanceof TesyError ? error.message : 'Could not process the MyTESY device list.'} Retrying automatically.`);
      }
      this.lastError = code;
      for (const controller of this.controllers.values()) controller.updateValues();
      return false;
    }
  }

  scheduleCommandRefresh() {
    if (this.stopped) return;
    for (const timer of this.commandTimers) clearTimeout(timer);
    this.commandTimers.clear();
    for (const delay of [1500, 5000, 16000]) {
      const timer = setTimeout(() => {
        this.commandTimers.delete(timer);
        void this.refresh();
      }, delay);
      timer.unref?.();
      this.commandTimers.add(timer);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    for (const timer of this.commandTimers) clearTimeout(timer);
    this.commandTimers.clear();
    this.client.close();
  }
}

module.exports = { TesyPlatform };
