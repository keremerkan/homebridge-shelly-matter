# Homebridge Matter bugs found during development (evidence log)

All reproduced on Homebridge v2.2.1, matter.js 0.17.6, with this plugin registering
11 accessories. Repro environments: macOS (Node 26) main bridge + Debian (Node 24)
main bridge; the production symptoms were first observed on a Debian child bridge.

## 1. Quick restart → Matter storage lock contention → Matter permanently dead

If a new Homebridge instance starts while the previous one is still shutting down
(typical for `hb-service restart` / systemd restart races), matter.js's storage
directory lock is still held:

```
[Matter/Server] Failed to start Matter server: [storage-lock] Storage is locked by another process (pid 268584)
[Matter/MainManager] Failed to initialize Matter server for main bridge: [storage-lock] Storage is locked by another process (pid 268584)
```

Homebridge then continues WITHOUT Matter for the process lifetime — no retry, no
recovery. A paired controller finds an empty/unreachable bridge; iOS eventually
drops all bridged devices, losing room assignments. Suggested fix: retry lock
acquisition with backoff (the previous process exits within seconds).

## 2. registerPlatformAccessories before server ready is silently swallowed

Registrations arriving while the Matter server is starting (or failed to start,
see #1) fail internally but the API call RESOLVES — plugins cannot detect it:

```
[Matter/MainManager] Failed to register Matter accessories for homebridge-shelly-matter: MatterDeviceError: Matter server not started
```

Later state updates are then rejected:

```
[Matter/MainManager] Ignoring Matter state update for <uuid>: accessory is not on this bridge
```

Suggested fix: queue registrations until the server is ready, or reject so the
plugin can retry. (Workaround in this plugin: read state back after registering
and retry every 3s.)

## 3. Cached Matter accessories restore as 0 despite populated accessories.json

`restoreCachedAccessories` consistently logs 0 even when the cache file has 11
entries (observed on both macOS and Linux, including runs where the Matter
server started successfully):

```
[Matter/Server] getAllCachedAccessories: Returning 0 accessories
[Matter/BaseManager] Restoring 0 cached Matter accessories
```

`MatterAccessoryCache.load()` runs at the end of `startServerNode` (after
`waitForServerReady`), but `restoreCachedAccessories` reads the cache
synchronously from `server.ts` / `childBridgeFork.ts` — the "Matter cache
loaded: N accessories" debug line was never observed before the restore in any
run. Consequence: `configureMatterAccessory` is never called, and (combined
with #4-adjacent design) the bridge starts with an empty parts list.

## 4. Bridge starts with empty parts list until plugins re-register (design)

Cached Matter accessories are only delivered to plugins (configureMatterAccessory);
endpoints are not restored into the aggregator before the server comes online.
A paired controller that syncs during startup sees all bridged devices removed
and discards their room assignments, then re-adds them as new devices when the
plugin's registrations land seconds later. HAP restores cached accessories into
the bridge before publishing; Matter should do the equivalent.

## 5. notifyPartsListChanged acquires locks synchronously and drops notifications

When an accessory registers on a commissioned bridge while any other state
transaction is in flight (controller subscriptions, attribute updates):

```
[Matter/ResourceSet] Transaction ◦offline#13c blocked by ◦offline#12f
[Matter/ResourceSet] You may need to await transaction.begin() to acquire locks asynchronously
[Matter/Server] Failed to notify controllers of parts list change: Cannot lock <bridge>.basicInformation.state synchronously
```

`increaseConfigurationVersion` should acquire its locks asynchronously / retry.
Only occurs while commissioned (`notifyPartsListChanged` short-circuits otherwise).

## 6. Stranded fabrics keep the bridge "commissioned" with no way to clean up

Aborted commissioning attempts leave orphan fabrics behind. Controller-initiated
removal (`removeFabric`) only deletes the controller's own fabric, so after
removing the bridge from e.g. Apple Home it can remain `commissioned: true,
fabricCount: 1` with a stale fabric (rootVendorId 0), never re-advertising for
pairing. Also: removal invoked while the bridge is offline/Matter-dead (see #1)
never reaches it at all. Homebridge exposes no fabric inspection/removal; the
only remedy is deleting the bridge's matter storage directory. Suggested:
fabric list + manual removal in the UI, and surfacing commissioned state.

## 7. Plugin activity aborts matter.js subscription re-establishment (root cause of slow hub reconnects)

Found 2026-07-23 by differential analysis against matterbridge (both on stock
@matter 0.17.5, byte-identical to npm; verified). matter.js's
`CommissioningServer#enterOnlineMode` calls
`SubscriptionsServer.reestablishFormerSubscriptions()` the moment a
commissioned node comes online: it proactively reconnects each controller
(`peer.connect`, 2s timeout) and resumes their persisted subscriptions. When
this succeeds (matterbridge always), a restarted bridge is back in the hub's
good graces within seconds and the restart is invisible. When it fails, the
server never retries, and Apple hubs keep transmitting on the dead CASE
session ("Ignoring message for unknown session") for minutes-to-never before
re-subscribing on their own.

On Homebridge it fails ("Reestablished 0 of 2 former subscriptions",
"Operation aborted", also "Fabric index #N does not exist" for former
subscriptions persisted for since-deleted fabrics - they are never purged):

- `ServerLifecycle.start()` returns ~200ms after `run()`; plugin
  registrations then stream in immediately and their transactions
  (`aggregator.add`, handler attach via `endpoint.act`, plus Homebridge's
  runtime `increaseConfigurationVersion()` on every parts change - something
  matterbridge never does at runtime) land inside the 2s re-establishment
  window and abort it.
- matterbridge by contrast builds the COMPLETE aggregator before `start()`
  (waits for all plugins started), so re-establishment runs on a quiescent
  node.

Composed accessories (BridgedNode + child parts) suffer most: their
multi-endpoint transactions are the heaviest, and Homebridge's cache-restore
shape check (device type name + sorted child part-id list; restored parts are
silently dropped if their cached deviceType fails to resolve) makes them the
most likely to take the full unregister+re-add churn path mid-reconnect.

Plugin-side mitigation (shipped): REESTABLISH_QUIET_MS - hold the
registration queue for 5s after launch. Safe because Homebridge (since our
#3969 fix) restores the full bridge structure from its own cache before
going online; only command handlers attach late.

Suggested upstream fixes: (a) defer node start until the initial
registration burst settles (matterbridge's ordering), or (b) queue/suppress
structural transactions until `reestablishFormerSubscriptions()` completes,
and retry it on failure; (c) purge persisted subscriptions when their fabric
is removed.

## 8. Composed-device identity gaps vs matterbridge (uniqueId, TagList, reachability)

Field-by-field structure diff of the same Shelly Pro 2PM under both stacks
(2026-07-23; metering placement/PowerTopology identical, so those are ruled
out). Three Homebridge-layer gaps, all invisible to plugins (the MatterAccessory
API cannot express them):

1. **Random uniqueId.** Homebridge never sets
   BridgedDeviceBasicInformation.uniqueId, so matter.js fills it with a
   RANDOM string persisted only in matter storage
   (BasicInformationServer.createUniqueId, Math.random). Controllers key
   bridged-accessory identity on uniqueId; if the persisted value is lost or
   the endpoint is rebuilt, the same device reappears as a new accessory
   (ghosts, room resets). matterbridge derives it deterministically:
   md5(name+serial+vendor+model). Patched locally: uniqueId =
   md5(accessory.UUID) in AccessoryManager.createEndpointOptions
   (patches/AccessoryManager-uniqueid-taglist.diff).
2. **No TagList on composed-device children.** Our two 2PM channels are
   identical OnOffOutlet endpoints distinguishable only by transient endpoint
   number; the spec directs semantic tags for identical children, and
   matterbridge tags each with CommonNumberTag (0,1) + label. Prime suspect
   for Apple mishandling the composed device across hub changes. Patched
   locally: DescriptorServer.with('TagList') + Number-namespace tag per part
   index in createAccessoryParts (same diff).
3. **Reachability is write-once.** Homebridge sets reachable:true at
   registration and has NO update path or ReachableChanged event anywhere;
   matterbridge flips the attribute + fires reachableChanged on device
   online/offline. Needs api.matter surface (e.g.
   updateAccessoryReachability(uuid, reachable)) - not patchable from
   outside without API addition.

Also noted: matterbridge adds FixedLabel("composed") on composed parents
(minor). Upstream candidates: (1)+(2) are small AccessoryManager PRs; (3) is
an API addition.
