# Changelog

## 1.0.0 — 2026-10-22

- Initial MyTESY cloud convector support based on the supplied Home Assistant integration.
- Native HomeKit thermostats with Heat/Off and 10–30 °C integer targets.
- Optional Comfort/Eco/Sleep switches, including return to manual mode.
- Shared HTTPS discovery/status requests and secure MQTT-over-WebSocket commands.
- Stable accessory cache IDs and per-device names, exclusions and preset visibility.
- Idle-safe availability, stale active-heating handling, bounded optimistic updates, command ordering and recovery after cloud failures.
- Credentials and device tokens excluded from accessory cache metadata and normal/debug output.
- Homebridge UI schema, source, lockfile, tests and packaging support.
