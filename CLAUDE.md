# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`homebridge-shelly-matter` exposes Shelly devices to Apple Home (and other
Matter controllers) through Homebridge 2.2+'s Matter API (`api.matter`),
including live power and cumulative energy metering (surfaced by iOS/tvOS 27+).
No HAP accessories are published; the plugin runs best in a child bridge with
`hap.enabled: false` and `matter: {}`.

## Layout and provenance

- `src/shelly/` — **vendored** Shelly protocol layer from
  [Luligu/matterbridge-shelly](https://github.com/Luligu/matterbridge-shelly)
  (Apache-2.0, see `NOTICE`). Keep diffs against upstream MINIMAL so future
  syncs stay easy: the only local changes are import rewrites
  (`matterbridge/logger` → `node-ansi-logger`, `matterbridge/utils` →
  `./utils/index.js`) and `src/shelly/utils/` vendored from Luligu/matterbridge.
  Do not refactor or "improve" this layer.
- `src/*.ts` (top level) — the plugin proper: `platform.ts` (lifecycle),
  `shellyAccessory.ts` (device→Matter mapping), `deviceConfig.ts` (config model).
- `homebridge-ui/` — custom settings UI (`@homebridge/plugin-ui-utils`), plain
  browser JS; it intentionally duplicates the type-resolution rules from
  `deviceConfig.ts` because it cannot import TS. Keep them in sync by hand
  (candidate improvement: have `server.js` compute effective types instead).
- `patches/` — dist-level diffs of the local Homebridge patch (see below) and
  the upstream PR materials.
- `UPSTREAM-ISSUES.md` — evidence log of all Homebridge Matter bugs found.

## Config model

Single `devices` array; one entry per physical device:
`{device: id, host?, name?, accessoryType?: light|outlet|switch, hidden?,
powerMetering?, channels?: [{channel (0-based), name?, accessoryType?, hidden?}]}`.
Resolution: channel setting → device setting → kind default (id contains
'plug' → outlet, else light). Entries record deviations, EXCEPT `host` which
the settings UI always auto-fills so mDNS can be disabled later. The settings
table is the primary editor; it rewrites entries wholesale on change.

## Hard-won constraints (do not silently change)

- **Serialized registrations** (`registrationQueue`): concurrent
  `registerPlatformAccessories` calls race matter.js endpoint locks.
- **`registerVerified()` — register, then POLL before re-registering**: on
  child bridges the registration is dispatched through an event bus and
  completes asynchronously 1-3s later; the API call resolves at emit. Homebridge
  also SWALLOWS registrations that arrive before its Matter server is ready
  (logs `Matter server not started` but resolves), so verification reads state
  back (`getAccessoryState` on an attribute the accessory actually declares)
  and retries up to ~80s. Re-registering too early hits the duplicate-UUID
  error; polling first prevents it.
- **Cache-shell registration at `didFinishLaunching`**: accessories are
  re-registered from `configureMatterAccessory` shells BEFORE discovery, using
  the serializable `context` ({deviceId, type, component/partTypes/
  partComponents}). Handlers bind lazily (component resolved at command time).
  On device connect, `accessorySignature` decides: match → `pushCurrentState`
  only; differ → unregister+register. Combined with the Homebridge patch this
  keeps the bridge parts list complete across restarts.
- **1s update-attach delay** (`ATTACH_SETTLE_MS`): live state transactions
  racing a registration's parts-list notify trip matter.js locks
  ("Cannot lock ... synchronously") on commissioned bridges.
- **Energy push throttle 30s** (`ENERGY_PUSH_MIN_INTERVAL_MS`): Homebridge
  documents that energy updates reach controllers unthrottled via
  CumulativeEnergyMeasured events.
- **`PROPERTY_MAP` is the single source** for Shelly property → Matter
  attribute mapping (snapshot AND live updates). Matter wants milli-units
  (mV/mA/mW/mWh); energy attributes are nested `{energy: n}`.
- **Identity rotation**: accessory identity embeds the effective composition —
  singles `uuid(deviceId|type)`, multis `uuid(deviceId|bridge|<idx:type,...>)`
  with part ids `componentId-type`. ANY composition change (retype, hide)
  rotates the WHOLE accessory (parent included) and the platform unregisters
  the previous identity first. Rationale: Apple Home breaks on same-uniqueId
  reappearances — uneditable settings pane, or an undeletable "Not Supported"
  parent if only children rotate. Never rotate halves; never reuse identity
  across structural change. Changing the seed scheme rotates EVERY accessory
  once (rooms reset) — avoid unless necessary.
- **`devices.json`** (`<storage>/shelly-matter/`): platform persists device
  sightings (id/host/gen/model/name/channels) for the settings UI; written
  debounced + atomically (tmp+rename). The UI must NOT run its own short mDNS
  scans as primary discovery (scanner's first query races its socket bind and
  re-queries only at 60s; responders rate-limit) — `/devices` from this file is
  primary, `/scan` (with 1s re-query loop) is fallback only.
- **WebSocket transport logs at warn** unless `debug`: Gen2+ Shellys close
  idle WebSockets by design; reconnect cycling is normal.

## Local Homebridge patch (until the fixes ship in a release)

Production requires patched Homebridge dist files (restore cached accessories
into the aggregator BEFORE the server node goes online + reconcile plugin
re-registrations in place). Without it, a paired controller resubscribes within
1s of server start, sees a shrunken parts list, and deletes devices (rooms
lost). Upstream: **merged as homebridge/homebridge#3969**; re-apply
`patches/*.diff` to `node_modules/homebridge/dist/matter/` after any Homebridge
update until a release contains it. Remaining upstream gaps tracked in
homebridge/homebridge#3970 (silent registration drop, storage-lock start
failure with no retry, dropped parts-list notifications).

## Homebridge/Matter operational knowledge

- **matter.js storage lock**: a quick restart where the old process still
  lives → Matter server fails to init for the process lifetime (no retry).
  Restart again. Reboots are safe (stale lock detected via dead PID).
- **Uninstalling the plugin with the UI's "remove data" option deletes the
  Matter commissioning storage** → un-pairs from Apple Home, rooms lost
  (README warns).
- Homebridge processes rename their title to literally `homebridge` — kill
  test instances by `/proc/PID/cwd` (Linux) / `lsof -a -p PID -d cwd` (macOS),
  NEVER by name pattern (self-match + production-match hazards).
- Stranded fabrics: aborted commissionings leave orphan fabrics keeping the
  bridge `commissioned: true`, refusing new pairings; only remedy is wiping
  `<storage>/matter/<bridge-id>/`. Controller-initiated removal only lands if
  the bridge is reachable at that moment.
- The Homebridge UI Accessories tab never shows Matter accessories (HAP-only).

## Apple Home behavioral findings (iOS/tvOS 27 beta)

- Tile wattage displays ONLY for outlet-typed accessories; light/switch types
  with identical ElectricalPowerMeasurement data show nothing on tiles (totals
  still correct). PowerTopology mode (Tree vs Set) is not consulted.
- Removing a bridge routinely strands 2-3 bridged accessories as unremovable
  ghosts (survive Remove Anyway, room-deletion trick, macOS app, hub reboots).
- Same-uniqueId reappearance after structural change → broken accessory records
  (see identity rotation above).
- Mixed-version hub fleets (tvOS 26 + 27) cause inconsistent Matter/energy
  behavior; isolate to a single tvOS 27 hub when debugging.
- Feedback Assistant drafts for the above: `~/Desktop/apple-feedback-drafts.md`.

## Testing

- Smoke pattern: stub `api` object (registerPlatform capture, `api.matter` stub
  with uuid/deviceTypes-proxy/register/unregister/update/getAccessoryState
  backed by a Set of registered UUIDs), real platform instance, real LAN
  devices (read-only; NEVER invoke On/Off against the user's devices).
  Two-phase runs simulate restarts: serialize run-1 registrations the way the
  homebridge cache does (strip handlers, deviceType → {name}) and feed them to
  `configureMatterAccessory` in run 2.
- Full-stack rig: throwaway Homebridge install (`npm i homebridge`) + storage
  dir + `-U ./storage -P <plugin>`; commission with a matter.js controller
  script (`ServerNode.create` + `peers.commission({passcode, discriminator})`)
  — the whole controller stack ships inside Homebridge's node_modules. On this
  Mac, mDNS same-host discovery fails when the bridge binds an interface
  (`bind: [en0]`); leave unbound for rig tests. en0 IS Wi-Fi here.
- Real-device data points: 5× Plus 1 (no metering), 5× Plus Plug S (metering),
  1× Pro 2PM (2 channels, ch0 has exported energy). Gen2 metering props:
  `apower` W, `voltage` V, `current` A, `aenergy.total` Wh.

## Release checklist (pre-publish)

- Unify UI/TS type-resolution rules (or server-computed effective types)
- Test on live server + real devices before any npm publish (user publishes)
- GitHub repo public + issues on, releases per version (Verified requirements;
  auto-discovery is allowed; plugin must not start unless configured — already
  satisfied since the platform only constructs with a config block)
- README: uninstall warning present; example config English-only
