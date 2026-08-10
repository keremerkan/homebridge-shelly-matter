# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-08-10

### Fixed

- Devices reached through a **Shelly Range Extender** (host of the form `extender-ip:port`) no longer fail their WebSocket connection with "Invalid URL: ws://ip:port:80/rpc" ([#5](https://github.com/keremerkan/homebridge-shelly-matter/issues/5)): the default port is only appended when the host does not already carry one. The same fix was reported to the upstream protocol layer.

## [0.5.1] - 2026-08-09

### Fixed

- **Gen 1 devices now receive state pushes** ([#4](https://github.com/keremerkan/homebridge-shelly-matter/issues/4)): the CoIoT (CoAP) listener was never started, so a change made at the wall switch (or in the Shelly app) never reached Matter controllers - and the resulting stale tiles made the first Home app tap command the state the device was already in, appearing to do nothing. The listener now starts whenever a Gen 1 device is known: at startup when one is recorded in devices.json, on a Gen 1 mDNS discovery, or on a Gen 1 device add. Gen 2/3-only setups never bind the CoAP port (their devices use WebSocket notifications).
- **Shelly 1 and Dimmer 2 are now field-tested** (thanks to the reporter of [#4](https://github.com/keremerkan/homebridge-shelly-matter/issues/4)): Gen 1 relays and the Dimmer 2 move to the tested tier, and the README gains a "Gen 1 devices and CoIoT" note explaining the same-network requirement of CoIoT multicast and the routed-unicast alternative (CoIoT peer set to the Homebridge machine).
- The mDNS scanner's per-packet parse warnings ("Cannot decode name (bad label)" and similar) are logged at debug level now ([#4](https://github.com/keremerkan/homebridge-shelly-matter/issues/4)). They fire for malformed multicast DNS packets from any device on the network, not just Shellys, and dropping such a packet is harmless.

## [0.5.0] - 2026-08-08

### Changed

- Homebridge **v2.3.0** (stable) is now the minimum version — the first stable release containing all the Matter fixes this plugin depends on. The beta-install instructions are gone from the README and the startup version check.
- The bridged accessories' firmware version and the `AlternatingCurrent` power-measurement feature, previously carried as local patches, ship in Homebridge 2.3.0 proper ([#3976](https://github.com/homebridge/homebridge/pull/3976), [#3977](https://github.com/homebridge/homebridge/pull/3977)).
- README: commissioned controllers (fabrics) are shown in Homebridge UI v5.27.1+; the UI also auto-creates Matter-only child bridges for this plugin (Matter on, HAP off) from that version.

## [0.4.0] - 2026-07-26

### Added

- **Periodic energy reporting**: metering devices now publish Matter PeriodicEnergy measurements (per-minute energy from Shelly's `aenergy.by_minute`, with the minute window timestamps) alongside the cumulative totals — richer, spec-complete data for any Matter controller. Note: this does not change Apple's Energy view, which lists per-device usage only for certified accessories (see the README's Apple Home behaviours).
- Declared the `supports-matter` transport keyword ([homebridge#3975](https://github.com/homebridge/homebridge/issues/3975)): current Homebridge UI betas now create new child bridges for this plugin with Matter on and HAP off by default, so the misleading HAP QR code no longer appears.
- The device firmware version is part of the accessory registration signature: a Shelly firmware update now re-registers the accessory in place, keeping the reported firmware current for controllers (surfaced once Homebridge ships bridged firmware support, [homebridge#3976](https://github.com/homebridge/homebridge/pull/3976)).

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
