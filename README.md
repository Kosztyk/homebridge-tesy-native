# Homebridge TESY Native

MyTESY cloud convectors in Apple Home, implemented from the cloud protocol in the supplied Home Assistant TESY integration 1.1.0. Home Assistant does not need to be running: this plugin communicates with MyTESY directly.

Package: `homebridge-tesy-native` · Platform: `TesyNative` · Author: **Kosztyk** · Version: **1.0.0**

## Features

- Automatically discovers compatible convectors in your MyTESY account.
- Exposes each convector as a native HomeKit **thermostat**, with **Off / Heat**, current temperature and a **10–30 °C** target in **1 °C** steps.
- Shows active heating separately from a powered-on heater that is idle.
- Adds optional **Comfort**, **Eco** and **Sleep** switches, on the same accessory.
- Supports device naming and exclusions by MAC address, plus per-device preset visibility.
- Restores accessories with stable IDs after a restart, preserving room assignments.
- Keeps idle devices available even when their device timestamps stop advancing, following the supplied integration.
- Reuses a secure MQTT connection for commands and polls device status every 30 seconds by default.
- Bounds optimistic changes and returns to the reported cloud value if a command is not confirmed.
- Includes the Homebridge settings schema, ready-to-run JavaScript, tests, lockfile and a GitHub Actions test workflow in the source archive.

## Requirements and device scope

- Node.js **22.12+ within Node 22**, or **Node 24**.
- Homebridge **1.8+** or **2.x**. Validation uses Homebridge 1.11.1 and 2.4.0 on Node 24.
- A MyTESY account and compatible internet-connected convector already working with the supplied integration.
- Outbound HTTPS to `ad.mytesy.com` on port 443 and secure WebSocket access to `mqtt.tesy.com` on port 8083.

This version implements the new MyTESY convector protocol from your integration. It recognises snapshots containing `status`, `temp` and `current_temp`. Legacy TESY Cloud devices and electric water heaters use different commands and are not imported.

The supplied Home Assistant integration also calculates energy estimates and exposes diagnostic sensors. This plugin provides the HomeKit thermostat and presets; it does not reproduce those energy/history sensors or expose unverified writable controls for UV, lock or anti-frost.

## Install the provided package

Copy `homebridge-tesy-native-1.0.0.tgz` onto your Homebridge host, for example into `/tmp`, then run:

```bash
sudo npm install -g /tmp/homebridge-tesy-native-1.0.0.tgz
sudo hb-service restart
```

The package contains the runtime files. There is no TypeScript compilation step. npm installs the MQTT dependency during installation. If your installation uses a different Homebridge restart method, restart it in the Homebridge UI instead.

After restarting, open **Plugins → TESY Native → Settings**, fill in the three account fields, save and restart Homebridge again.

## Account settings

Use the **same email, password value and user ID** configured in your working Home Assistant TESY integration. Its `user_id` field is called `userId` here. It is an account identifier, not a MAC address or an email address. The plugin also accepts `user_id` in manually written JSON for compatibility.

This plugin follows the integration's `/get-my-devices` authentication and does not try to obtain a user ID through a separate login flow. If the Home Assistant configuration uses a portal-provided password value, copy that exact value.

Add this object to the existing `platforms` array, or enter the values in the plugin's settings form:

```json
{
  "name": "TESY Native",
  "username": "your-email@example.com",
  "password": "YOUR_MYTESY_PASSWORD",
  "userId": "YOUR_MYTESY_USER_ID",
  "exposePresets": true,
  "pollInterval": 30,
  "platform": "TesyNative"
}
```

Leave the device overrides list empty to import all compatible convectors. A blank override row is ignored and cannot disable discovery.

## Device overrides

The discovery log prints the device name, MAC and model. Copy a MAC to override one device:

```json
"devices": [
  {
    "mac": "AA:BB:CC:DD:EE:FF",
    "name": "Bedroom heater",
    "exclude": false,
    "exposePresets": true
  },
  {
    "mac": "11:22:33:44:55:66",
    "exclude": true
  }
]
```

MAC matching ignores letter case, colons and hyphens. Setting `exclude: true` removes that device's cached accessory; adding it again may require assigning its room again. Devices missing briefly from a cloud response retain their cached identity.

## Thermostat and preset behaviour

| Home action | MyTESY command | Behaviour |
| --- | --- | --- |
| Select Heat | `onOff` with `status: on` | Enables the convector; does not claim that the element is already heating. |
| Select Off | `onOff` with `status: off` | Disables the convector. |
| Change target | `setTemp` with integer `temp` | Changes the setpoint; does not power the convector on. |
| Turn a preset on | `setMode` with `name: comfort`, `eco` or `sleep` | Selects that preset and updates all three switches. Preserves the power state. |
| Turn the selected preset off | `setMode` with `name: heating` | Returns to the manual heating mode defined in the supplied MyTESY portal bundle. Preserves the power state. |
| Turn an inactive preset off | No command | Leaves the active mode unchanged. |

Preset temperature/time settings continue to use the values configured in MyTESY. A preset switch can remain selected while the thermostat is Off, just as the preset remains configured in the source integration. No cooling or automatic cooling mode is advertised.

Apple Home may group the thermostat and switches into one accessory. Open its accessory settings and choose **Show as Separate Tiles** if you want separate tiles.

## Refresh and availability

| Setting | Default | Meaning |
| --- | ---: | --- |
| `pollInterval` | 30 seconds | Time between background cloud polls. Minimum 15 seconds. |
| `requestTimeout` | 8 seconds | Timeout for an HTTP request, MQTT connection or MQTT publish. |
| `offlineAfter` | 300 seconds | Time without a successful cloud response containing the device before HomeKit reads report a communication error. |
| `staleHeatingAfter` | 600 seconds | Maximum age of a device timestamp while it still claims active heating. |
| `exposePresets` | `true` | Adds the three preset switches. Can be overridden per device. |
| `debug` | `false` | Logs selected temperature/mode/status fields. |

Status refreshes are shared across accessories and never overlap. HomeKit reads use the most recent snapshot instead of making one request per characteristic.

An old idle/off device timestamp alone does not produce No Response. A stale timestamp that still claims active heating is treated as inactive, matching the supplied integration. Timestamps without a timezone offset are interpreted as UTC, as in its helper.

After a successful MQTT publish, the requested values are shown for up to 15 seconds while polls at approximately 1.5, 5 and 16 seconds look for confirmation. Confirmed values stop being optimistic immediately. If MyTESY keeps reporting the previous value, the plugin restores it and logs a warning. A QoS 0 publish callback confirms that the client sent the message; it is not a device acknowledgement. Failed or timed-out commands are never queued for later replay.

During a short cloud outage the last snapshot remains readable for the configured grace period. A sustained outage reports No Response. Account errors, network errors and recovery are logged without dumping credential-bearing URLs or device tokens.

## Source, testing and packaging

From the extracted source directory:

```bash
npm ci
npm run check
npm test
npm pack
```

The resulting `.tgz` includes the entry point, all runtime modules, settings schema and documentation. `package-lock.json`, the test suite and the CI workflow are in the source archive. Runtime dependencies are declared in `package.json`; `homebridge` is a development dependency, not a second Homebridge installation at runtime.

Tests use Homebridge's real accessory and characteristic classes. They cover cloud authentication/errors, MQTT command topics, WebSocket packet transport, safe temperatures, stale/idle status, queued writes, preset semantics, failed commands, confirmation expiry, outage recovery, discovery exclusions, token refresh and accessory restoration. They do not authenticate to a live MyTESY account or operate a physical heater.

## Publishing

The metadata targets `Kosztyk/homebridge-tesy-native`. Create that GitHub repository and upload this source if you want to publish it. The plugin name and `homebridge-plugin` / `supports-hap` keywords are included for Homebridge discovery after npm publication.

After pushing your source and testing it, publish from the source directory with your own npm account:

```bash
npm login
npm run check
npm test
npm pack --dry-run
npm publish --access public
```

The archive is ready for publication; creating it does not publish to GitHub or npm. Registry availability of the package name must be checked when publishing. No Homebridge verification status is claimed.

## References

- User-supplied `tesy.zip`, integration version 1.1.0: `api.py`, `const.py`, `coordinator.py`, `climate.py`, `status.py` and the included portal bundle.
- [Homebridge dynamic platform API](https://developers.homebridge.io/homebridge/interfaces/DynamicPlatformPlugin.html)
- [Homebridge plugin conventions](https://github.com/homebridge/plugins)
- [MQTT.js API](https://github.com/mqttjs/MQTT.js)

MIT license. Unofficial community software.
