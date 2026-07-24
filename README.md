# homebridge-shelly-matter

Expose [Shelly](https://www.shelly.com) devices to Apple Home (and other Matter controllers) through [Homebridge](https://homebridge.io) 2.x — **including live power and cumulative energy metering**, which Apple Home displays starting with iOS/tvOS 27.

HomeKit's own accessory protocol (HAP) has no energy characteristics; Matter has. Homebridge v2.2.0 added the Matter `ElectricalPowerMeasurement` and `ElectricalEnergyMeasurement` clusters to its plugin API, and this plugin bridges Shelly's native metering onto them.

## Requirements

- Homebridge **v2.2.0 or later** with [Matter enabled](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0) on the bridge — **plus the Matter fixes listed under [Known issues](#known-issues-homebridge-core-fixes-pending) below**
- Node.js 22.12+
- iOS/tvOS 27+ to see energy data in Apple Home (the accessories themselves work on earlier versions)

## Known issues (Homebridge core fixes pending)

This plugin exposes each device as a **composed** Matter accessory (a bridged
node with one endpoint per channel). Apple Home only models composed
accessories correctly when the parent endpoint carries `FixedLabel` and
`PowerSource` clusters, and reliable restarts depend on how Homebridge brings
its Matter node online. Both are fixed in Homebridge core, but the fixes are
**not in a released Homebridge yet** — they are open pull requests:

- **[homebridge/homebridge#3972](https://github.com/homebridge/homebridge/pull/3972)** — FixedLabel + PowerSource on composed parents (plus stable accessory identity and semantic tags). **Without this, controls work for ~30 seconds after pairing and then permanently stop responding** (tiles keep showing live state; commands are silently dropped). This affects every device this plugin exposes.
- **[homebridge/homebridge#3973](https://github.com/homebridge/homebridge/pull/3973)** — defer the Matter node coming online until registrations settle, and keep controller subscriptions alive across restarts. Without it, bridged devices may drop to "No Response" and lose their room assignments after a Homebridge restart.
- **[homebridge/homebridge#3974](https://github.com/homebridge/homebridge/issues/3974)** — surface commissioned controllers (fabrics) in the Homebridge UI. Until then this plugin shows them in its own settings page ("Connected controllers").

### Running Homebridge with the fixes today

Until the fixes ship in an official Homebridge release, a **prebuilt Homebridge
package** containing them (current 2.2.2 beta + both PRs, full test suite
passing) is available from
[keremerkan/homebridge releases](https://github.com/keremerkan/homebridge/releases) —
download `homebridge-2.2.2-fixes.1.tgz` and install it **over your existing
Homebridge**:

- **npm-based installs** (`npm install -g homebridge`):

  ```sh
  sudo npm install -g ./homebridge-2.2.2-fixes.1.tgz
  ```

- **Official Debian / Raspberry Pi package or `hb-service` installs** (Homebridge
  lives under the storage path, with Node in `/opt/homebridge`):

  ```sh
  sudo env PATH=/opt/homebridge/bin:$PATH \
      npm --prefix /var/lib/homebridge install ./homebridge-2.2.2-fixes.1.tgz
  sudo systemctl restart homebridge   # or: sudo hb-service restart
  ```

- **Docker** (official image): run the same `npm --prefix /var/lib/homebridge install …`
  inside the container (`docker exec -it homebridge sh`), then restart the container.

After restarting, the Homebridge UI should report version **`2.2.2-fixes.1`**.
To build from source instead: clone the
[`beta-2.2.2-with-fixes`](https://github.com/keremerkan/homebridge/tree/beta-2.2.2-with-fixes)
branch, then `npm ci && npm run build && npm pack` and install the resulting tarball as above.

Two caveats: updating Homebridge from the UI **replaces this build** (re-install
the tarball afterwards), and this whole section will be replaced by a plain
`engines.homebridge` version floor once an official release contains the fixes.

These are also **Apple Home** behaviours, not plugin bugs: the same 30-second
control-loss and stranded-fabric issues are being reported to Apple separately.

One more Apple Home behaviour to be aware of: **tile wattage only appears on
outlet-typed accessories.** Power metering works for every accessory type this
plugin exposes, but lights and switches — even though they publish identical
power and energy data — show no consumption on their own tiles. Their usage is
still measured and included in the Home app's whole-home energy view. If you
want live wattage on a device's tile, set its accessory type to outlet.

## Device support

Support comes in three tiers. "Tested" means validated against real devices on
a live Apple Home installation; "untested" means the mapping is implemented by
faithfully following the same protocol layer the tested devices use, but no
real device of that kind has been on our bench yet. **If you run an untested
device, please [report whether it works](https://github.com/keremerkan/homebridge-shelly-matter/issues)** —
one confirmation moves it to tested.

### Supported and tested

- **Shelly Gen 2/3 relays and plugs** (Plus/Pro 1, 1PM, 2PM in switch profile, Plus Plug S, …)
  - On/off control (as light, outlet, or switch — configurable per channel)
  - Live power (W), voltage, current
  - Cumulative energy (kWh), including returned energy where the device measures it
- Multi-channel devices appear as a single grouped accessory, with a separate control per channel.

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
      "name": "Cinema",
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
- `channels` — per-channel settings for multi-channel devices (`channel` is 0-based): `accessoryType`, `hidden`. The device `name` applies to the whole device; individual channel tiles are renamed in the Home app. Channels without an entry use the device settings.
- `powerMetering` — set `false` to drop the power/energy clusters on a metering device.

Devices need no entry at all when the defaults fit — entries only record deviations.

The platform also accepts `mdnsDiscover` (default `true`). Set it to `false` to turn off background mDNS discovery — devices with a configured `host` still connect directly, so this is safe once every device has a fixed IP. New devices are then added by IP in this list, or via the settings UI's **Scan network** button (which runs a one-off scan regardless of this setting).

## Changing a device's accessory type

Changing the accessory type of a device or channel deliberately re-creates its
Matter accessory with a fresh identity (Apple Home mishandles devices that
reappear with the same identity but a different device type, leaving them
uneditable). The re-created accessory returns to the default room — reassign
it once after the change.

## Uninstalling / reinstalling

If the Homebridge UI option to remove plugin data on uninstall is enabled, uninstalling this plugin also deletes the bridge's **Matter commissioning storage** — which un-pairs it from Apple Home and discards room assignments. To move or reinstall the plugin without re-pairing, keep that option off (or back up `<storage>/matter/<bridge-id>/` first); the pairing survives a plain reinstall.

## Attribution

The Shelly protocol and device layer (`src/shelly/`) is derived from [matterbridge-shelly](https://github.com/Luligu/matterbridge-shelly) by Luca Liguori, licensed under Apache-2.0 — see `NOTICE`. This plugin is an independent port to the Homebridge Matter plugin API and is not affiliated with Matterbridge or Allterco Robotics.
