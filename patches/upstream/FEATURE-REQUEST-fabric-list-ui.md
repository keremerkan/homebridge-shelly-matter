# Feature request: surface commissioned Matter fabrics in the UI (replace the HAP-era "paired" flag)

## Problem

For a Matter child bridge, the Homebridge UI shows a single boolean-ish
"paired" state carried over from HAP. Matter bridges are multi-fabric: a
single Apple Home pairing enrolls **two** fabrics (a home-labelled AppleHome
fabric + an unlabelled Apple Keychain fabric), and additional ecosystems
(Google, Alexa, SmartThings) each add their own. "Paired" cannot express any
of this, which makes several real situations undiagnosable from the UI:

- A bridge that shows "paired" but is actually stranded on a leftover fabric
  after a controller-side removal (commissioned, but not the fabric the user
  thinks) — it won't re-advertise for pairing and the user has no way to see
  why.
- Not knowing which/how many controllers currently have access (e.g. before
  selling or repurposing hardware).
- No way to remove a specific fabric from the UI.

Standalone Matter bridges (e.g. matterbridge) show the full fabric list in
their web UI, which is what users now expect.

## The data already exists in core

`dist/matter/server/FabricManager.js` already computes everything needed:

- `getFabricInfo()` → `[{ fabricIndex, fabricId, nodeId, rootVendorId, label }]`
- `getCommissioningSnapshot()` (coalesced count + list)
- `removeFabric(fabricIndex)` (already implemented)

`rootVendorId` identifies the controller vendor (0x1349 Apple Home, 0x1384
Apple Keychain, 0x6006 Google, 0x1217 Amazon, 0x1049 SmartThings, …); `label`
carries the home name for AppleHome fabrics.

The gap is purely plumbing + display:

1. **Core:** include the fabric list in `ChildBridgeMatterManager.get-
   MatterStatusInfo()` (currently `{qrCode, manualPairingCode, serialNumber,
   commissioned, deviceCount}` — no `fabricCount`, no list) so it flows to
   `ChildBridgeService.getMetadata()` and out to the UI alongside the other
   Matter status fields.
2. **config-ui-x:** render the list where the "paired" indicator is today —
   vendor + optional home label + fabric index; optionally a per-fabric
   "Remove" action wired to the existing `removeFabric()`.

## Working reference

The `homebridge-shelly-matter` plugin implements the read side in its custom
settings UI today, without any core change, by reading the Matter node's
persisted `fabrics.fabrics` store directly and mapping `rootVendorId` to a
vendor name (see `homebridge-ui/server.js` `fabrics()` / `homebridge-ui/
public/index.html` "Connected controllers"). That proves the data and the
UX; the native UI should show it from the commissioning snapshot rather than
each plugin re-reading storage.

## Suggested scope

- Small core PR: add `fabrics` (from `getCommissioningSnapshot()`) and
  `fabricCount` to the Matter status info payload.
- config-ui-x PR: replace/augment the "paired" pill with the fabric list;
  optional remove button.
- Bonus (separate but related): a minor bug — `commissioned` stays `true`
  after the last fabric is removed until the next restart; the snapshot count
  is the accurate source of truth.

## Notes

- Same investigation that produced the composed-parent and deferred-online
  Matter PRs; this is UPSTREAM-ISSUES #6 from that work.
- Exposing the fabric list on `api.matter` (so plugins don't re-read storage)
  would also be welcome, in the spirit of #3966 (MatterStatus on api.matter).
