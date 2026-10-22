# Validation — 1.0.0

Validated on 2026-10-22 using Node.js 24.19.0.

| Check | Result |
| --- | --- |
| JavaScript syntax, JSON and plugin metadata | Passed |
| Homebridge 2.4.0, real HAP accessory/characteristic classes | 30 tests passed |
| Homebridge 1.11.1, real HAP accessory/characteristic classes | 30 tests passed |
| Real MQTT.js over a local WebSocket test broker | Correct CONNECT and command PUBLISH packets; QoS 0, no retained commands, no subscriptions |
| npm package contents | 14 files, including the entry point, every runtime module and settings schema |
| Clean install of the final .tgz with production dependencies only | Passed |
| Installed package platform registration, thermostat/preset creation and HomeKit temperature write | Passed with simulated account/device responses |
| Packed runtime bytes compared with final source | Match |

The tests cover protocol formatting, authentication/error handling, temperature validation, fresh and stale heating state, idle availability, command ordering, failed commands, preset changes, optimistic update expiry, cloud recovery, token refresh, discovery exclusions and cache restoration.

No live MyTESY account authentication or physical heater commands were attempted. Physical-device validation is still needed after installation. This project has not been published to GitHub or npm by this creation task.
