'use strict';

const { normaliseMac } = require('./settings');

function stateOn(value) {
  return value === true || value === 1 || (typeof value === 'string' && ['on', '1', 'true'].includes(value.toLowerCase().trim()));
}

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let text = value.trim();
  // The HA helper treats dates without an explicit offset as UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) text = text.replace(' ', 'T') + 'Z';
  const n = Date.parse(text);
  return Number.isFinite(n) ? n : undefined;
}

function derivedState(state, now, staleAfter) {
  const updated = timestamp(state.updated_at);
  const staleHeating = stateOn(state.heating) && (updated === undefined || now - updated > staleAfter);
  const on = !staleHeating && (stateOn(state.status) || stateOn(state.heating));
  return { on, heating: !staleHeating && stateOn(state.heating), staleHeating };
}

function normaliseDevices(raw) {
  const devices = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const state = value.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const mac = String(value.mac || state.mac || key).trim();
    const id = normaliseMac(mac);
    if (!id) continue;
    // The supplied integration's commands are for new MyTESY convectors.
    // Boilers and legacy power_status devices use a different protocol.
    if (!Object.hasOwn(state, 'status') || !Object.hasOwn(state, 'temp') || !Object.hasOwn(state, 'current_temp')) continue;
    const kind = String(value.type ?? value.device_type ?? '').toLowerCase();
    if (kind.includes('boiler') || kind.includes('water')) continue;
    devices.set(id, {
      id, mac, device: { ...value, mac }, state: { ...state },
      name: typeof value.deviceName === 'string' && value.deviceName.trim()
        ? value.deviceName.trim() : `Tesy Convector ${id.slice(-6)}`,
    });
  }
  return devices;
}

module.exports = { stateOn, finiteNumber, timestamp, derivedState, normaliseDevices };
