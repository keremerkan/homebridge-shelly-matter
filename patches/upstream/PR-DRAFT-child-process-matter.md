# PR draft: Matter — bring bridge nodes online only after startup registrations settle

> Status: DRAFT — under active development/validation on a live deployment.
> Sections marked TODO are filled in as the implementation and testing progress.
>
> History: this draft originally proposed moving child bridge Matter servers
> into the child process. Code archaeology showed that is ALREADY the
> architecture (the child owns its ServerNode, storage, port, mDNS, and
> commissioning; verified on a live install — the matter port is bound by the
> child pid). The remaining delta against known-good standalone bridges
> (matterbridge) is startup ordering alone, which is what this PR now targets.

## Title

Matter: protect subscription re-establishment at startup (bring node online
only after initial registrations settle)

## Summary

When a commissioned matter.js node comes online,
`SubscriptionsServer.reestablishFormerSubscriptions()` proactively reconnects
every controller (2-second connection timeout per peer) and resumes their
persisted subscriptions. There is no retry on failure. When it succeeds, a
bridge restart is invisible to controllers — Apple hubs are reconnected within
seconds. When it fails, hubs keep transmitting on their dead CASE sessions
("Ignoring message for unknown session") for minutes, sometimes until a
home-hub election — user-visible as "No Response" across the bridge after
every Homebridge restart.

Homebridge currently brings the node online ~200 ms after creation
(`ServerLifecycle.start()` → `run()`), while plugin registrations and handler
attachments stream in immediately afterwards. Their transactions
(`aggregator.add`, handler attach via `endpoint.act`,
`increaseConfigurationVersion()`) land inside the 2-second window and abort
the re-establishment.

This PR changes the startup ordering to the model standalone Matter bridges
use: build/restore the complete bridge first, bring the node online once, and
let re-establishment run against a quiescent node.

## Evidence

Debugged over several days against Apple Home (iOS/tvOS 27, multiple hubs)
with a bridge of 11 devices, side by side with the matterbridge project on the
same LAN, same devices, same hubs — both running stock, byte-identical
`@matter` 0.17.5 (installed trees diffed against the npm tarballs to rule out
a modified stack).

- matterbridge (which starts its node only after all plugins registered):
  restart → `Resumed session` within seconds, rooms and reachability retained,
  every time.
- Homebridge: restart → `Reestablished 0 of 2 former subscriptions`,
  `Operation aborted`, then minutes of `Ignoring message for unknown session`
  from the hubs; devices No Response until the hub independently
  re-subscribes (or a hub switch forces it).
- Additionally: `Failed to connect to @N Fabric index #N does not exist` —
  former subscriptions are persisted per fabric but never purged when the
  fabric is removed, so re-establishment also wastes its window on deleted
  fabrics.

TODO: attach before/after log excerpts once the fix is validated live.

## Design

1. **Defer online until the initial registration burst settles.**
   The node is created and the accessory cache restored into the aggregator
   exactly as today (#3969), but `run()` is held until plugins have had their
   `didFinishLaunching` turn and the Matter registration queue has been idle
   for a short settle period (bounded by a cap so a stuck plugin cannot block
   startup — TODO: exact mechanism/values from implementation).
   Registrations arriving later (e.g. network discovery) still apply to the
   live node as today; by then controllers are connected and parts-list
   changes are ordinary bridge behavior.
2. **Purge persisted subscriptions when their fabric is removed** so
   re-establishment never spends its window on dead fabrics.
3. TODO (evaluate): retry `reestablishFormerSubscriptions()` once if it
   reports 0 successes with commissioned fabrics present — or upstream this
   to matter.js.

## What this PR does NOT change

- Process architecture: child bridge Matter servers already run inside the
  child bridge process (own storage under `matter/<username>`, own port from
  the central allocator, own mDNS via the per-process environment, graceful
  SIGTERM `node.close()` with storage-lock retry on restart). Independent
  child restarts already cycle the node cleanly.
- Plugin-facing `api.matter` — unchanged.
- Existing pairings — storage, identity, port untouched.

## Changes

TODO — file-by-file list once the implementation lands. Expected center of
mass: `matter/server/ServerLifecycle.js` (start ordering),
`matter/server/AccessoryManager.js` (queue-idle signal),
subscription purge on fabric-removal event (`matter/server/FabricManager.js`).

## Testing

TODO — to be filled from live validation:

- [ ] Restart commissioned child bridge: `Reestablished N of N former
      subscriptions`, hubs reconnected in seconds, rooms retained, no
      unknown-session spam
- [ ] Kill -9 the child: watchdog restart, clean re-establishment
- [ ] Quick double-restart: storage-lock retry path still green
- [ ] Composed (BridgedNode + child parts) accessory reachable through
      restarts and hub switches
- [ ] Stale-fabric former subscriptions purged (no "Fabric index does not
      exist" during re-establishment)
- [ ] Fresh pairing unaffected; late-discovered devices still register live
- [ ] Side-by-side behavioral parity with matterbridge on the same LAN

## Notes for reviewers

- Same investigation lineage as #3969/#3970; we can run any additional
  scenarios on our deployment (11 Shelly devices, Apple Home with multiple
  tvOS 27 hubs, one hub with a known reconnect quirk).
- A plugin-side workaround (holding the plugin's own registrations back 5 s)
  validates the mechanism but cannot be the fix: it is a timer heuristic, it
  only covers the one plugin, and it cannot cover Homebridge's own
  `increaseConfigurationVersion()` transactions.
