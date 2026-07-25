# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-25

### Added

- **Periodic energy reporting**: metering devices now publish Matter PeriodicEnergy measurements (per-minute energy from Shelly's `aenergy.by_minute`, with the minute window timestamps) alongside the cumulative totals — richer, spec-complete data for any Matter controller. Note: this does not change Apple's Energy view, which lists per-device usage only for certified accessories (see the README's Apple Home behaviours).

## [0.3.0] - 2026-07-25

### Added

- `splitChannels` ([#2](https://github.com/keremerkan/homebridge-shelly-matter/issues/2)): multi-channel devices can expose each channel as its own accessory, so channels can be assigned to different rooms in Apple Home (rooms are per accessory — even "separate tiles" of one accessory always move rooms together). Toggle per device in the settings UI; changing it re-creates the device's accessories.
- Per-channel `name` is back — used in the Home app only when the device's channels are split (grouped devices keep using the device name plus channel number).
- Composition changes (split, type, hidden) are now applied during the bridge restart **before the Matter node comes online**, so paired controllers see a clean transition instead of a live structure mutation — the latter can desync Apple Home until the hub is rebooted.
- **Splitting is the default for multi-channel devices**: their channels usually switch unrelated loads in different rooms, so each channel now arrives as its own accessory unless `splitChannels: false` is set. **Upgrade note:** a multi-channel device that was grouped (the old default) will be re-created as split accessories on update — set `splitChannels: false` (or untick Split in the settings) before updating to keep it grouped, and expect a one-time room reassignment either way.
- Rotated accessories always get a **never previously used identity** (a rotation generation is embedded in the identity seed): reverting a change no longer resurrects endpoints controllers recently deleted, which Apple Home mishandles. Existing accessories keep their identities.

## [0.2.2] - 2026-07-25

### Changed

- Clearer startup messages ([#1](https://github.com/keremerkan/homebridge-shelly-matter/issues/1)): the version check now names the actual minimum Homebridge version (v2.2.2-beta.7), shows the version you are running, and gives the beta install command; the Matter-not-enabled warning walks through the Homebridge UI toggles ("Enable Matter", optionally disabling "Enable HAP") and points users who want classic HAP exposure to homebridge-shelly-ng.
- README states the Matter-only positioning up front, with the same pointers.

## [0.2.1] - 2026-07-25

### Changed

- Requires Homebridge **v2.2.2-beta.7 or later** (`engines.homebridge` now enforces it). The Homebridge core Matter fixes this plugin depended on ([homebridge#3972](https://github.com/homebridge/homebridge/pull/3972), [homebridge#3973](https://github.com/homebridge/homebridge/pull/3973)) are merged and published, so the custom Homebridge build is no longer needed — the README's workaround section is gone, replaced by a plain version requirement.

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
