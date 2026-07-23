# PR draft for homebridge/homebridge

**Branch:** `fix/matter-restore-cached-accessories-before-online` (based on v2.2.1)
**Apply:** fork homebridge/homebridge, then
`git am 0001-fix-matter-restore-cached-accessories-before-online.patch`
(TypeScript sources; `tsc --noEmit` and eslint clean against v2.2.1.)

---

## Title

fix(matter): restore cached accessories into the bridge before going online

## Description

**The problem.** On every restart of a commissioned Matter bridge, the server
node comes online with an empty aggregator parts list — cached accessories are
only delivered to plugins via `configureMatterAccessory`, never rebuilt into
the bridge. A paired controller re-establishes its subscription within the
first second (log excerpt below, Apple TV hub), reads a parts list containing
0-2 of 11 devices, treats the missing endpoints as removed, and discards their
metadata: **room assignments and tile settings are lost on nearly every
restart**, with the devices re-added as "new" seconds later when plugin
registrations land. Endpoint identity is not the issue — endpoint numbers and
`BridgedDeviceBasicInformation.uniqueId` are byte-stable across restarts
(verified from matter.js storage); the transient parts-list shrink alone
triggers the controller-side deletion.

```
11:05:00 PM [Matter/Node] 0E8093EB8676 is online
11:05:01 PM [Matter/InteractionServer] Subscription successfully reestablished ...
11:05:01 PM [Matter/Server] Registered Matter accessory: (1 of 11)   <- too late
...
11:05:11 PM [Matter/Server] Registered Matter accessory: (11 of 11)
```

There is no race plugins can win: even batching all registrations into one
call loses to a same-second subscription. HAP solved the equivalent problem
years ago by restoring cached accessories into the bridge before publishing;
Matter needs the same.

**The fix.**

1. `ServerLifecycle.start()` invokes a new optional dep,
   `restoreAccessoriesFromCache()`, after the aggregator is created and
   **before** `startServerNode()`.
2. `MatterServer` implements it: load the accessory cache, rebuild each cached
   accessory (device types resolved back through the public `deviceTypes`
   registry from their cached names) and register it through the normal
   `AccessoryManager.registerAccessory` path, marked with an internal
   `_restoredFromCache` flag. Handlers cannot be cached, but custom behaviors
   (e.g. the OnOff server on switch device types) are only attached for
   clusters that have handlers — empty stubs are synthesized per cached
   cluster so the restored endpoint is structurally identical to the original.
3. `AccessoryManager.registerAccessory`: when a plugin re-registers a UUID
   whose accessory is `_restoredFromCache`, attach the plugin's handlers and
   metadata to the existing endpoint in place (no parts-list churn) instead of
   throwing the duplicate-UUID error. If the structure changed (device type or
   part ids), unregister the restored endpoint and register fresh.

**Also fixed as a side effect:** `restoreCachedAccessories()` currently logs
`Restoring 0 cached Matter accessories` even with a populated
`accessories.json`, because the cache is only loaded at the end of
`startServerNode()` — after the synchronous restore call sites in `server.ts`
/ `childBridgeFork.ts` have already read it. The pre-online hook loads the
cache first, so `configureMatterAccessory` now fires with the cached
accessories as designed.

**Testing.** Live bridge (child bridge, `hap.enabled: false`), 11 accessories
covering single-endpoint devices, a composed BridgedNode with typed parts, and
electrical measurement clusters, paired with an Apple Home hub (tvOS 27):

- restore completes before `going online`; the controller's first read sees all 11
- plugin re-registration attaches in place: no duplicate-UUID errors, no
  "Cluster 'onOff' not found", commands work end to end
- endpoint numbers and uniqueIds byte-identical across restarts
- room assignments survive repeated bridge restarts (previously lost)
- fresh-pair (empty cache) path unchanged; structural-change path re-registers

**Notes for reviewers.**

- Stub handlers are a workaround for handlers being non-serializable. A
  cleaner follow-up would be caching the handler *shape* (cluster/command
  names) in `SerializedMatterAccessory`, but the stubs keep the cache format
  unchanged and behave identically for behavior selection.
- Restored accessories could be marked `reachable: false` until the plugin
  attaches; left out to keep the diff minimal.
- Related but not fixed here (can file separately): registrations arriving
  while the Matter server is starting are logged
  (`MatterDeviceError: Matter server not started`) but the API call resolves,
  so plugins cannot detect the drop; storage-lock contention on a quick
  restart permanently disables Matter for the process lifetime with no retry;
  and `notifyPartsListChanged`'s `increaseConfigurationVersion` acquires locks
  synchronously and drops notifications under concurrent transactions.
