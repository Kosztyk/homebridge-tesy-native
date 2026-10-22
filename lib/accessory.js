'use strict';

const { PRESETS } = require('./settings');
const { finiteNumber, derivedState } = require('./state');
const { TesyError } = require('./client');

const COMMAND_GRACE_MS = 15000;

class TesyAccessory {
  constructor(platform, accessory, metadata, options = {}) {
    this.platform = platform;
    this.accessory = accessory;
    this.options = options;
    this.id = metadata.id;
    this.name = metadata.name;
    this.record = null;
    this.lastSeen = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.configure(metadata);
  }

  configure(metadata) {
    const { Service, Characteristic: C } = this.platform.api.hap;
    const a = this.accessory;
    a.displayName = this.name;
    a.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'TESY')
      .setCharacteristic(C.Model, String(metadata.model || 'Cloud Convector').slice(0, 64))
      .setCharacteristic(C.SerialNumber, metadata.mac || this.id)
      .setCharacteristic(C.FirmwareRevision, String(metadata.firmware || 'Unknown').slice(0, 64));
    this.thermostat = a.getService(Service.Thermostat) || a.addService(Service.Thermostat, this.name);
    this.thermostat.setPrimaryService(true);
    this.thermostat.setCharacteristic(C.Name, this.name);
    if (!this.thermostat.testCharacteristic(C.ConfiguredName)) this.thermostat.addOptionalCharacteristic(C.ConfiguredName);
    this.thermostat.setCharacteristic(C.ConfiguredName, this.name);
    this.thermostat.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.readCurrentTemperature());
    this.thermostat.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 30, minStep: 1 })
      .onGet(() => this.readTargetTemperature())
      .onSet(value => this.setTemperature(value));
    this.thermostat.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => this.readCurrentMode());
    this.thermostat.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ minValue: C.TargetHeatingCoolingState.OFF, maxValue: C.TargetHeatingCoolingState.HEAT,
        validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT] })
      .onGet(() => this.readTargetMode())
      .onSet(value => this.setPower(value));
    this.thermostat.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => a.context.tesyDisplayUnits ?? C.TemperatureDisplayUnits.CELSIUS)
      .onSet(value => {
        if (![C.TemperatureDisplayUnits.CELSIUS, C.TemperatureDisplayUnits.FAHRENHEIT].includes(value)) throw this.invalidValue();
        a.context.tesyDisplayUnits = value;
        this.platform.api.updatePlatformAccessories([a]);
      });
    if (!this.thermostat.testCharacteristic(C.StatusFault)) this.thermostat.addOptionalCharacteristic(C.StatusFault);
    this.thermostat.getCharacteristic(C.StatusFault).onGet(() => this.available() ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);

    const expose = this.options.exposePresets ?? this.platform.config.exposePresets;
    this.presets = new Map();
    for (const mode of PRESETS) {
      const subtype = `tesy:preset:${mode}`;
      let service = a.getServiceById(Service.Switch, subtype);
      if (!expose) {
        if (service) a.removeService(service);
        continue;
      }
      const name = `${this.name} ${mode[0].toUpperCase()}${mode.slice(1)}`;
      service ||= a.addService(Service.Switch, name, subtype);
      service.setCharacteristic(C.Name, name);
      if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
      service.setCharacteristic(C.ConfiguredName, name);
      service.getCharacteristic(C.On)
        .onGet(() => this.readPreset(mode))
        .onSet(value => this.setPreset(mode, Boolean(value)));
      this.presets.set(mode, service);
    }
  }

  available() {
    return this.lastSeen !== null && this.platform.now() - this.lastSeen <= this.platform.config.offlineAfter;
  }

  communicationError() {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  invalidValue() {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
  }

  assertAvailable() {
    if (!this.available() || !this.record) throw this.communicationError();
  }

  effectiveState() {
    this.assertAvailable();
    const state = { ...this.record.state };
    const now = this.platform.now();
    for (const [key, pending] of this.pending) {
      if (now < pending.expires) state[key] = pending.value;
      else {
        this.pending.delete(key);
        if (pending.report) this.platform.log.warn(`[${this.name}] Cloud has not confirmed ${key}; showing its reported value again.`);
      }
    }
    return state;
  }

  update(record, receivedAt) {
    this.record = record;
    this.lastSeen = receivedAt;
    for (const [key, pending] of this.pending) {
      if (record.state[key] === pending.value || String(record.state[key]) === String(pending.value)) this.pending.delete(key);
    }
    this.updateValues();
  }

  readCurrentTemperature() {
    const n = finiteNumber(this.effectiveState().current_temp);
    if (n === undefined || n < -40 || n > 100) throw this.communicationError();
    return n;
  }

  readTargetTemperature() {
    const n = finiteNumber(this.effectiveState().temp);
    if (n === undefined || n < 10 || n > 30) throw this.communicationError();
    return n;
  }

  readCurrentMode() {
    const C = this.platform.api.hap.Characteristic;
    const derived = derivedState(this.effectiveState(), this.platform.now(), this.platform.config.staleHeatingAfter);
    return derived.heating ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF;
  }

  readTargetMode() {
    const C = this.platform.api.hap.Characteristic;
    const derived = derivedState(this.effectiveState(), this.platform.now(), this.platform.config.staleHeatingAfter);
    return derived.on ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF;
  }

  readPreset(mode) { return this.effectiveState().mode === mode; }

  setTemperature(value) {
    const n = finiteNumber(value);
    if (n === undefined || n < 10 || n > 30) return Promise.reject(this.invalidValue());
    const temp = Math.round(n);
    return this.mutate(() => ({ command: 'setTemp', payload: { temp }, changes: { temp }, description: `Set temperature to ${temp} °C` }));
  }

  setPower(value) {
    const C = this.platform.api.hap.Characteristic;
    if (![C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT].includes(value)) return Promise.reject(this.invalidValue());
    const on = value === C.TargetHeatingCoolingState.HEAT;
    return this.mutate(() => {
      const changes = { status: on ? 'on' : 'off' };
      const current = derivedState(this.effectiveState(), this.platform.now(), this.platform.config.staleHeatingAfter);
      // A redundant Heat command preserves fresh, observed heating. A power
      // command never creates a new claim of active element heating.
      if (!on || current.staleHeating) changes.heating = 'off';
      return { command: 'onOff', payload: { status: on ? 'on' : 'off' }, changes, description: on ? 'Turned on' : 'Turned off' };
    });
  }

  setPreset(mode, on) {
    if (!PRESETS.includes(mode)) return Promise.reject(this.invalidValue());
    return this.mutate(() => {
      if (!on && this.effectiveState().mode !== mode) return null;
      const name = on ? mode : 'heating';
      return { command: 'setMode', payload: { name }, changes: { mode: name }, description: `Selected ${on ? mode : 'manual heating'} mode` };
    });
  }

  mutate(build) {
    const task = this.queue.then(async () => {
      if (this.platform.stopped) throw this.communicationError();
      this.assertAvailable();
      const action = build();
      if (!action) { this.updateValues(); return; }
      try {
        // Resolve metadata here, after preceding writes, so refreshed tokens win.
        await this.platform.client.sendCommand(this.record.device, action.command, action.payload);
      } catch (error) {
        this.platform.log.warn(`[${this.name}] Command failed: ${error instanceof TesyError ? error.message : 'TESY command could not be sent.'}`);
        throw this.communicationError();
      }
      const expires = this.platform.now() + COMMAND_GRACE_MS;
      for (const [key, val] of Object.entries(action.changes)) {
        this.pending.set(key, { value: val, expires, report: key !== 'heating' });
      }
      this.platform.log.info(`[${this.name}] ${action.description}.`);
      this.updateValues();
      this.platform.scheduleCommandRefresh();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  updateValues() {
    const C = this.platform.api.hap.Characteristic;
    const readings = [
      [C.CurrentTemperature, () => this.readCurrentTemperature()],
      [C.TargetTemperature, () => this.readTargetTemperature()],
      [C.CurrentHeatingCoolingState, () => this.readCurrentMode()],
      [C.TargetHeatingCoolingState, () => this.readTargetMode()],
    ];
    for (const [type, read] of readings) {
      try { this.thermostat.updateCharacteristic(type, read()); }
      catch { this.thermostat.updateCharacteristic(type, this.communicationError()); }
    }
    this.thermostat.updateCharacteristic(C.StatusFault, this.available() ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);
    for (const [mode, service] of this.presets) {
      try { service.updateCharacteristic(C.On, this.readPreset(mode)); }
      catch { service.updateCharacteristic(C.On, this.communicationError()); }
    }
  }
}

module.exports = { TesyAccessory, COMMAND_GRACE_MS };
