# PR draft: Matter — composed (parts-bearing) accessories need FixedLabel and PowerSource on the parent endpoint

## Title

Matter: add FixedLabel and PowerSource clusters to composed accessory parents
(fixes Apple Home controls dying ~30s after pairing)

## Summary

Any Matter accessory registered with `parts` (a BridgedNode parent with child
endpoints) is uncontrollable from Apple Home beyond the first ~30 seconds
after pairing. Reads keep working indefinitely; every command fails silently
("No Response") with no error on either side. Flat accessories are unaffected.

Root cause (established by log-streaming the Apple TV home hub's `homed`
daemon and byte-diffing Matter descriptor dumps against a working reference
bridge): Apple's controller cannot build its internal model for a composed
bridged device unless the parent endpoint also exposes a **FixedLabel**
cluster and a **PowerSource** cluster. Without them, homed's per-accessory
session setup silently stalls:

- the child endpoints never bind to the composed accessory,
- homed's Matter-report→characteristic translation produces zero updates for
  the whole node (its `MTRDevice` layer receives our reports fine),
- the accessory-info model never populates, the accessory is never
  "configured", and homed's *Add accessory pairing operation* times out after
  ~30 s with `HMErrorDomain Code=4 (accessoryNotReachable)`.

The ~30 s of working control after pairing is the commissioning iPhone
controlling the accessory directly while that operation is still pending —
which makes the failure look like a mysterious timeout rather than a
modeling error. Nothing is logged at any level a bridge operator can see.

The fix is two clusters on the parent endpoint of parts-bearing accessories:

- `FixedLabel` with `labelList: [{ label: "composed", value: <kind> }]`
- `PowerSource` (Wired feature) with static wired-AC state

This matches what the matterbridge project has always exposed on composed
parents (`addFixedLabel('composed', …)` and
`createDefaultPowerSourceWiredClusterServer()`), which is why bridges built
on it never exhibited the failure.

## Evidence

- Descriptor diff of a WORKING composed parent (matterbridge, same Apple
  hub/LAN) vs a Homebridge composed parent:
  ServerList `[Descriptor, BridgedDeviceBasicInformation, PowerSource,
  FixedLabel]` vs `[BridgedDeviceBasicInformation, Descriptor]`. Child
  endpoints are equivalent.
- Bisect on a 40-line test plugin (included as the reproducer): flat
  OnOffLight works; the same accessory as BridgedNode+part fails; adding
  FixedLabel alone → accessory no longer surfaces in Home; adding
  FixedLabel + PowerSource → works indefinitely (verified >2 min of
  continuous toggling, including hub-routed commands with the phone on
  cellular).
- Hub-side marker: `homed`'s `HMDMatterAttributeChangedNotification` count
  for the node goes from 0 (broken, all captures) to hundreds (fixed),
  with `Configuring with HAPAccessory` appearing only once the clusters are
  present.
- With the fix, an 11-device production bridge (mixed flat/composed, mixed
  light/outlet/switch types) survives everything that previously failed:
  control past the timeout, Homebridge restarts with room assignments
  intact, and home-hub elections (which previously re-adopted composed
  accessories as new, resetting rooms, every time).

Environment: Homebridge v2.2.2-beta.5, @matter 0.17.5, Apple Home on
iOS/tvOS 27 beta (multiple hubs). The same failure signature was present on
earlier tvOS-26.x observations of composed accessories.

## Implementation sketch (validated as a dist patch in production)

In `AccessoryManager` (where the parent endpoint for a parts-bearing
accessory is built):

```ts
if (accessory.parts && accessory.parts.length > 0) {
  deviceType = deviceType.with(FixedLabelServer);
  endpointOptions.fixedLabel = {
    labelList: [{ label: 'composed', value: kindLabel }],
  };
  deviceType = deviceType.with(PowerSourceServer.with('Wired'));
  endpointOptions.powerSource = {
    status: 1,            // Active
    order: 0,
    description: 'AC Power',
    endpointList: [],
    wiredCurrentType: 1,  // AC
  };
}
```

Notes for a proper implementation:

- `kindLabel`: matterbridge uses the device class ("Light"/"Switch"); deriving
  it from the first part's device type name seems right. The validated patch
  hardcoded one value; Apple did not appear to care about the string.
- PowerSource here describes the bridge device's mains supply; if the API
  later grows battery-state support, the plugin should be able to override.
- Both clusters are cheap static state; no runtime maintenance needed.

## Reproducer

Minimal plugin (~40 lines, one virtual OnOffLight, no hardware needed) that
registers the accessory either flat (works) or as BridgedNode+part (fails
without this fix): see attached `minimal-repro/`. Pair the child bridge with
Apple Home, toggle for 60 s. Failure mode: toggles work ~30 s, then permanent
"No Response" while the tile still shows live state.

## Notes for reviewers

- Same investigation lineage as #3969/#3970; we can run any scenario on our
  deployment (11 Shelly devices, Apple Home, multiple tvOS 27 hubs).
- This is Apple-behavior-driven, not spec-mandated — the spec does not
  require these clusters on composed parents. We plan to file the silent
  30-second-timeout failure mode with Apple separately; but exposing the
  clusters is the pragmatic fix and matches the only bridge stack Apple
  demonstrably works with.
- Related cosmetic fix worth bundling: the "No custom behavior class
  available for cluster 'electricalPowerMeasurement'" warning fires for
  attribute-only clusters that have no commands; it should be suppressed
  for clusters without accepted commands.
