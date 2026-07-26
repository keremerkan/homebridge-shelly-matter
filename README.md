# homebridge-shelly-matter

[![npm version](https://img.shields.io/npm/v/homebridge-shelly-matter)](https://www.npmjs.com/package/homebridge-shelly-matter)
[![node](https://img.shields.io/node/v/homebridge-shelly-matter)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/homebridge-shelly-matter)](LICENSE)

Expose [Shelly](https://www.shelly.com) devices to Apple Home (and other Matter controllers) through [Homebridge](https://homebridge.io) 2.x — **including live power and cumulative energy metering**, which Apple Home displays starting with iOS/tvOS 27.

HomeKit's own accessory protocol (HAP) has no energy characteristics; Matter has. Homebridge v2.2.0 added the Matter `ElectricalPowerMeasurement` and `ElectricalEnergyMeasurement` clusters to its plugin API, and this plugin bridges Shelly's native metering onto them.

**This is a Matter-only plugin** — it publishes no HAP accessories, so a Matter-enabled bridge is required: in the Homebridge UI, open the plugin's bridge settings and turn on **"Enable Matter"** (optionally turning off **"Enable HAP"**, which this plugin does not use). If you want classic HAP exposure and don't need energy metering, use [homebridge-shelly-ng](https://github.com/alexryd/homebridge-shelly-ng) instead.

## Requirements

- Homebridge **v2.2.2-beta.7 or later** with [Matter enabled](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0) on the bridge. Earlier versions are missing the composed-accessory Matter fixes this plugin depends on ([#3972](https://github.com/homebridge/homebridge/pull/3972), [#3973](https://github.com/homebridge/homebridge/pull/3973), both now merged) — on them, Apple Home stops responding to controls ~30 seconds after pairing. Until 2.2.2 stable ships, install the beta: `sudo npm install -g homebridge@beta` (or select the beta version in the Homebridge UI).
- Node.js 22.12+
- iOS/tvOS 27+ to see energy data in Apple Home (the accessories themselves work on earlier versions)

## Pairing with Apple Home

Pair using the bridge's **Matter pairing code — not the HAP QR code**. A child
bridge with HAP enabled advertises both, and since this plugin publishes no
HAP accessories, pairing the HAP QR code adds an **empty bridge with no
devices**. The Matter pairing code and QR are printed in the Homebridge log at
startup. Turning off **"Enable HAP"** in the bridge settings removes the
misleading HAP QR code entirely — recommended, since this plugin does not use
HAP at all.

## Apple Home behaviours

- **Tile wattage follows the Matter device type: only outlet-typed accessories
  show it.** Power metering works for every accessory type this plugin exposes,
  but lights and switches — even though they publish identical power and energy
  data — show no consumption on their own tiles. To get live wattage, set the
  channel's accessory type to **outlet**. Prefer a light look? Use the Home
  app's **"Show As" → Light** on the outlet afterwards — the display override
  does not affect wattage (verified against certified hardware as well), and
  "Show As" is only offered on outlet-typed accessories in the first place.
- **Apple's Energy view lists individual devices only for certified (native)
  Matter accessories.** Bridged accessories' consumption is counted in the
  whole-home total, but they are not listed per-device — regardless of
  reporting shape, power topology, or endpoint structure (we verified by
  replicating a certified smart plug's exact Matter structure on this bridge).
  A Homebridge bridge cannot carry a device attestation certificate, so this
  is an Apple policy limitation, not a plugin gap.
- Commissioned controllers (fabrics) are not yet shown in the Homebridge UI
  ([homebridge/homebridge#3974](https://github.com/homebridge/homebridge/issues/3974));
  this plugin lists them in its own settings page ("Connected controllers").

## Device support

Support comes in three tiers. "Tested" means validated against real devices on
a live Apple Home installation; "untested" means the mapping is implemented by
faithfully following the same protocol layer the tested devices use, but no
real device of that kind has been on our bench yet. **If you run an untested
device, please [report whether it works](https://github.com/keremerkan/homebridge-shelly-matter/issues)** —
one confirmation moves it to tested.

### Supported and tested

- **Shelly Gen 2/3 relays and plugs** (Plus/Pro 1, 1PM, 2PM in switch profile, Pro 4PM, Plus Plug S, …)
  - On/off control (as light, outlet, or switch — configurable per channel)
  - Live power (W), voltage, current
  - Cumulative energy (kWh), including returned energy where the device measures it
- Multi-channel devices appear as **independent accessories per channel by default**, so each channel can live in its own room; set `splitChannels: false` to group them into a single accessory with a control per channel.

### Supported, not yet tested on real hardware

- **Covers / rollers** (2PM in cover profile, Plus Shutter, Gen 1 rollers): open/close/stop,
  target position, position and movement state, power metering where the device measures it.
- **Dimmers** (Shelly Dimmer/Dimmer 2, Plus Wall Dimmer, 0-10V Dimmer, Dimmer Gen3, Pro Dimmer):
  on/off and brightness.
- **Gen 1 relays** (Shelly 1, 1PM, 2.5 in relay mode, Gen 1 plugs): on/off over CoIoT.
  Gen 1 power metering is not mapped yet.

### Could be supported — ask for it

The vendored protocol layer already parses these; they need (and will get) a
Matter mapping. [Open an issue](https://github.com/keremerkan/homebridge-shelly-matter/issues)
if you own one and want it prioritized — we can usually provide a beta build to test:

- RGB / RGBW / CCT lights (RGBW2, Plus RGBW PM, bulbs)
- Sensors: H&T (temperature/humidity), Flood, Door/Window, Motion, Smoke — including battery level
- Buttons and inputs (i3, i4, wall inputs) as stateless switches
- Standalone energy meters (EM, 3EM, Pro EM, PM Mini)
- TRV / thermostats, and BLU devices via a Shelly BLE gateway

Not mappable to Matter: gas sensors (no Matter device type), vibration.

Devices without supported components are discovered but skipped with a log message.

## Configuration

Most configuration happens in the plugin settings UI: discovered devices appear in a table where each device gets a friendly name, and each device (or each channel of a multi-channel device) gets an accessory type and a hide toggle. Everything is stored in a single `devices` array:

```json
{
  "platform": "ShellyMatter",
  "name": "ShellyMatter",
  "mdnsDiscover": true,
  "devices": [
    { "device": "shellyplus1-441793AABBCC", "name": "Office Ceiling" },
    { "device": "shellyplus1-441793DDEEFF", "accessoryType": "switch" },
    {
      "device": "shellypro2pm-EC62AABBCC",
      "name": "Garage",
      "channels": [
        { "channel": 0, "name": "Garage Light" },
        { "channel": 1, "name": "Garage Door", "accessoryType": "switch" }
      ]
    },
    {
      "device": "shellypro2pm-EC62DDEEFF",
      "name": "Cinema",
      "splitChannels": false,
      "channels": [
        { "channel": 1, "accessoryType": "switch", "hidden": true }
      ]
    },
    { "host": "192.168.1.50", "powerMetering": false }
  ]
}
```

- `device` — the device id. One entry per physical device.
- `host` — IP address/hostname; needed for devices mDNS cannot find, or for every device when mDNS discovery is disabled (they are added directly).
- `name` — the name shown in the Home app.
- `accessoryType` — `light`, `outlet`, or `switch`. Applies to relay/switch channels only (covers and dimmers have a fixed type). Defaults: plugs are outlets, wired relay devices are lights.
- `hidden` — set `true` to not expose the device (or a channel) to Matter at all.
- `channels` — per-channel settings for multi-channel devices (`channel` is 0-based): `name`, `accessoryType`, `hidden`. A channel `name` is only used in the Home app when the device's channels are **split** into separate accessories (the default) — grouped devices always use the device `name` plus the channel number, and their tiles are renamed in the Home app. Channels without an entry use the device settings.
- `splitChannels` — multi-channel devices only, **on by default**: each channel is its own accessory, so channels can be assigned to different rooms (Apple Home assigns rooms per accessory — even "separate tiles" of one accessory always move rooms together). Set `false` to expose the device as one grouped accessory. Changing this re-creates the device's accessories with fresh identities — reassign rooms after.
- `powerMetering` — set `false` to drop the power/energy clusters on a metering device.

Devices need no entry at all when the defaults fit — entries only record deviations.

The platform also accepts `mdnsDiscover` (default `true`). Set it to `false` to turn off background mDNS discovery — devices with a configured `host` still connect directly, so this is safe once every device has a fixed IP. New devices are then added by IP in this list, or via the settings UI's **Scan network** button (which runs a one-off scan regardless of this setting).

## Changing a device's accessory type or split setting

Changing the accessory type of a device or channel — or toggling
`splitChannels` — deliberately re-creates its Matter accessories with fresh
identities (Apple Home mishandles devices that reappear with the same identity
but a different structure, leaving them uneditable). The change is applied
while the bridge restarts, before it comes back online, so paired controllers
see a clean transition. Apple Home processes the change asynchronously — the
re-created accessories typically appear after **2–3 minutes**, in the room the
bridge itself is assigned to; move them to their rooms once after the change.

Make all structural changes in **one settings pass** rather than several in a
row: Apple Home ingests structure changes slowly, and back-to-back changes can
make the second one take considerably longer to appear.

Troubleshooting: Apple Home's ingestion of structure changes can stall — if a
re-created accessory has not appeared after ~5 minutes, **reboot your Apple
TV/HomePod hub** and give it a few minutes; the pending change then processes
(existing accessories keep their rooms). In the worst case the bridge may
briefly show as "Matter Accessory" with devices missing — the same hub reboot
heals it, though the bridge tile's own name/room may need to be set again.

## Uninstalling / reinstalling

If the Homebridge UI option to remove plugin data on uninstall is enabled, uninstalling this plugin also deletes the bridge's **Matter commissioning storage** — which un-pairs it from Apple Home and discards room assignments. To move or reinstall the plugin without re-pairing, keep that option off (or back up `<storage>/matter/<bridge-id>/` first); the pairing survives a plain reinstall.

## Attribution

The Shelly protocol and device layer (`src/shelly/`) is derived from [matterbridge-shelly](https://github.com/Luligu/matterbridge-shelly) by Luca Liguori, licensed under Apache-2.0 — see `NOTICE`. This plugin is an independent port to the Homebridge Matter plugin API and is not affiliated with Matterbridge or Allterco Robotics.
