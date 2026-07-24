# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-24

### Added

- **Cover / roller support** (untested tier): Shelly covers (2PM in cover profile, Plus Shutter, Gen 1 rollers) are exposed as Matter window coverings with open/close/stop, target position, live position and movement state, and power metering where the device measures it.
- **Dimmer support** (untested tier): Shelly dimmers (Dimmer/Dimmer 2, Plus Wall Dimmer, 0-10V, Dimmer Gen3, Pro Dimmer) are exposed as Matter dimmable lights with on/off and brightness.
- Three-tier device support matrix in the README (tested / supported-untested / could-be-supported) with an issue-tracker call for reports from owners of untested devices.
- The settings UI marks cover and dimmer channels with their fixed kind and an "untested" badge, and links to the issue tracker.

### Changed

- The settings UI computes all configuration rules server-side (`/device-view` and `/apply-view`); the browser page is pure presentation, so the UI can never disagree with what the plugin registers.
- The config schema no longer forces an accessory type with a `light` default; an unset type now correctly means the kind-based default (outlet for plugs, light otherwise).
- Power-metering gating, property mapping, and unregistration bookkeeping consolidated after a code-quality review; the state-update hot path got cheaper (O(1) property lookup, energy conversions skipped while throttled).

### Fixed

- A `{ "host": ..., "hidden": true }` entry now hides its device on the mDNS discovery path too; previously the hidden flag was only honored when the device was added by IP.

### Known issues

- Still requires the pending Homebridge core Matter fixes (see the README's "Known issues"). A prebuilt Homebridge package containing them is available from [keremerkan/homebridge releases](https://github.com/keremerkan/homebridge/releases), with install instructions in the README.

## [0.1.1] - 2026-07-24

### Changed

- A device's name now applies to the whole device only; per-channel names were removed from the settings UI, config schema, and documentation. Individual channel tiles are renamed in the Home app.

## [0.1.0] - 2026-07-24

Initial release.

### Added

- Expose Shelly Gen 2/3 relays and plugs to Apple Home over Matter via the Homebridge 2.2 Matter API.
- Live power, voltage, current and cumulative energy through the Matter ElectricalPowerMeasurement / ElectricalEnergyMeasurement clusters, shown on Apple Home tiles and in the Energy view on iOS/tvOS 27+.
- Per-device and per-channel accessory types (light / outlet / switch) with kind-based defaults, friendly names, and hide toggles — all in a single `devices` configuration array.
- Multi-channel devices exposed as composed Matter bridged nodes, one endpoint per channel; accessory identity rotates cleanly when a type or composition changes.
- Settings GUI with mDNS auto-discovery, manual host entry for devices mDNS cannot reach, and a "Connected controllers" list showing the Matter fabrics (e.g. Apple Home, Apple Keychain) commissioned on the bridge.
- Shelly protocol layer (CoIoT for Gen 1, WebSocket RPC for Gen 2+, mDNS discovery, password-protected device support) vendored from [matterbridge-shelly](https://github.com/Luligu/matterbridge-shelly) by Luca Liguori (Apache-2.0) — see `NOTICE`.

### Known issues

- Requires Homebridge core Matter fixes that are not yet in a released Homebridge (composed-accessory FixedLabel/PowerSource, deferred node start). Without them, Apple Home stops responding to controls ~30 seconds after pairing. See the "Known issues" section in the README for the tracking pull requests.
