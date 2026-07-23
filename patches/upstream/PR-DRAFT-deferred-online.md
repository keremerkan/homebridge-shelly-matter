# PR draft: Matter — defer node start until initial registrations settle; protect subscription re-establishment

## Title

Matter: bring bridge nodes online only after the initial registration burst,
and keep subscription re-establishment healthy across restarts

## Summary

When a commissioned matter.js node comes online,
`SubscriptionsServer.reestablishFormerSubscriptions()` proactively reconnects
every controller that had a persisted subscription (2-second connection
timeout per peer, no retry). When this succeeds, a bridge restart is
invisible: the hub is re-subscribed within seconds and bridged accessories
never drop out. When it fails, Apple hubs keep transmitting on their dead
CASE sessions ("Ignoring message for unknown session") for minutes — visible
to users as every bridged device going "No Response" after each Homebridge
restart, historically with room assignments being lost.

Today Homebridge undermines this mechanism in two ways:

1. **The node goes online ~200 ms after creation**, while plugin
   registrations stream in immediately afterwards. Their transactions
   (`aggregator.add`, handler attachment, `increaseConfigurationVersion()`)
   land inside the 2-second window and abort re-establishment
   ("Reestablished 0 of 2 former subscriptions", "Operation aborted").
   Standalone bridges (matterbridge) never hit this because they build the
   complete aggregator before starting the node.
2. **Persisted subscriptions for deleted fabrics are never purged**, so
   re-establishment wastes its window on peers that no longer exist
   ("Failed to connect to @N Fabric index #N does not exist").

This PR makes the child-bridge Matter server start in a deferred-online mode:
the node is fully built (accessory cache restored, initial plugin
registrations applied to the offline node) and only then brought online — so
its first advertisement carries the final structure and re-establishment runs
against a quiescent node. It also purges persisted subscriptions when their
fabric is removed.

## Changes (validated as dist patches in production)

1. **`ServerConfig` / `ServerLifecycle`: `deferOnline` mode.**
   `start()` builds the node, creates the aggregator, restores the accessory
   cache — and, with `deferOnline`, skips `startServerNode()`. The existing
   `runServer()` path ("deferred server with device(s) already attached",
   previously restricted to external-accessory mode) is opened up to
   `deferOnline` and brings the node online later.
2. **`MatterServer`: registration activity signal.** `registerPlatform-
   Accessories()` stamps `lastRegistrationAt`; a tiny `isDeferredPreOnline()`
   accessor exposes the mode.
3. **`ChildBridgeMatterManager`: settle loop.** After `start()`, poll until
   registrations have been idle for 2 s (capped at 45 s so a stuck or
   registration-less plugin cannot keep the bridge offline — the cap logs a
   warning and goes online anyway), then `runServer()`.
4. **`BaseMatterManager.isBridgeServerStarting()` made defer-aware.** The
   registration reject-guard added for #3970 (reject registrations before
   the server is running) would otherwise deadlock deferred mode: the server
   waits for registrations, the guard rejects them for the server not
   running. Offline registration is exactly what deferred mode wants — the
   cache-restore path already proves `registerAccessory` works on the
   offline node.
5. **Purge persisted subscriptions on fabric removal** so re-establishment
   only spends its 2-second window on live peers.

## Evidence

- Before: every restart of a commissioned bridge logged
  `Reestablished 0 of 2 former subscriptions` / `Operation aborted`,
  followed by minutes of hub dead-session traffic and "No Response" tiles;
  with a stale fabric present, also `Fabric index #N does not exist`.
- After: restarts log `Deferred online mode - Matter node built, waiting for
  initial registrations` → online ~7-10 s later →
  `Reestablished 1 of 1 former subscriptions successfully` within the same
  second — verified repeatedly on an 11-device production bridge via both
  `systemctl restart` and stop/start. Room assignments survive; the hub's
  only trace is a few seconds of stale tiles while secondary peers (phone,
  standby hubs) re-establish their own sessions.
- Subscription persistence itself already works (written at graceful close);
  the failures were entirely the two issues above.

## Notes for reviewers

- Same lineage as #3969/#3970 and the composed-parent FixedLabel/PowerSource
  PR; validated together on the same deployment, but independent — this one
  is about restart behavior, that one about Apple's composed-device
  modeling.
- The 2 s / 45 s settle constants are pragmatic; an explicit "initial
  registrations complete" signal from plugins would be cleaner, but no such
  API contract exists today and the idle heuristic has been reliable.
- Plugins that register accessories long after launch (e.g. from network
  discovery) are unaffected: late registrations apply to the live node
  exactly as today; deferred mode only front-loads whatever arrives during
  the settle window.
- Main-bridge Matter and external accessories are unchanged; the mode is
  enabled for child bridges, where all plugin registrations are in-process.
