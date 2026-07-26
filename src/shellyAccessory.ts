import type { MatterAccessory } from 'homebridge';

// Not re-exported from 'homebridge', so derive the part type from MatterAccessory.
type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];

import { ACCESSORY_TYPES, type AccessoryType, channelConfig, configForDevice, defaultAccessoryType, resolveAccessoryType as resolveConfiguredAccessoryType, splitChannelsEnabled } from './deviceConfig.js';
import type { ShellyMatterPlatform } from './platform.js';
import { isCoverComponent, isLightComponent, isSwitchComponent, type ShellyComponent } from './shelly/shellyComponent.js';
import type { ShellyDevice } from './shelly/shellyDevice.js';
import type { ShellyData, ShellyDataType } from './shelly/shellyTypes.js';
import { isValidNumber, isValidObject } from './shelly/utils/index.js';

/**
 * The component kinds this plugin maps to Matter. Switch components carry a
 * configurable accessory type (light/outlet/switch); covers and dimmers have
 * a fixed Matter device type.
 */
export type ComponentKind = 'switch' | 'cover' | 'dimmer';

/** A part's identity token: the accessory type for switches, the kind otherwise. */
type PartToken = AccessoryType | 'cover' | 'dimmer';

// Matter electrical measurement attributes use milli-units: mV, mA, mW, mWh.
const milli = (value: number): number => Math.round(value * 1000);

// Energy updates are pushed to controllers unthrottled (CumulativeEnergyMeasured
// events), so Homebridge documents a 30-60s cadence. Shelly notifies more often.
const ENERGY_PUSH_MIN_INTERVAL_MS = 30_000;

type ClusterState = Record<string, unknown>;

// Shelly covers report 100 = fully open; Matter lift percent100ths uses
// 0 = fully open, 10000 = fully closed.
const liftFromPosition = (pos: number): number => Math.round((100 - pos) * 100);
const positionFromLift = (lift: number): number => Math.round(100 - lift / 100);

// Matter WindowCovering MovementStatus: 0 stopped, 1 opening, 2 closing.
const OPERATIONAL_STATUS: Record<string, { global: number; lift: number }> = {
  opening: { global: 1, lift: 1 },
  closing: { global: 2, lift: 2 },
};
const OPERATIONAL_STOPPED = { global: 0, lift: 0 };

// Shelly brightness is 1-100; Matter LevelControl (Lighting) levels are 1-254.
const levelFromBrightness = (brightness: number): number => Math.max(1, Math.round((brightness * 254) / 100));
const brightnessFromLevel = (level: number): number => Math.max(1, Math.min(100, Math.round((level / 254) * 100)));

// matter.js epoch-s fields take UNIX seconds and validate them against the
// Matter epoch floor (2000-01-01 = 946684800); the wire conversion is its job.
const EPOCH_S_MINIMUM = 946_684_800;

/**
 * Cumulative + periodic energy fragment for one direction. Shelly's `aenergy`
 * carries the lifetime total (Wh) and `by_minute` (mWh per minute, [0] = most
 * recent) with `minute_ts` marking that minute - per-minute periodic energy is
 * exactly what Apple Home's per-device energy attribution wants, and the
 * PeriodicEnergy feature is enabled by these attributes being present at
 * registration.
 */
const energyFragment = (direction: 'Imported' | 'Exported') => (v: ShellyDataType): ClusterState | undefined => {
  if (!isValidObject(v) || !isValidNumber((v as ShellyData).total, 0)) return undefined;
  const data = v as ShellyData;
  const fragment: ClusterState = { [`cumulativeEnergy${direction}`]: { energy: milli(data.total as number) } };
  const byMinute = (data.by_minute as unknown[] | undefined)?.[0];
  const minuteTs = data.minute_ts;
  if (isValidNumber(byMinute, 0) && isValidNumber(minuteTs, EPOCH_S_MINIMUM)) {
    // by_minute is already in mWh - Matter's energy unit.
    fragment[`periodicEnergy${direction}`] = {
      energy: Math.round(byMinute as number),
      startTimestamp: minuteTs as number,
      endTimestamp: (minuteTs as number) + 60,
    };
  }
  return fragment;
};

/**
 * The Shelly-property -> Matter-attribute map, used both to build the initial
 * cluster snapshot at registration and to forward live updates - one table so
 * the two can never disagree about what is metered and how it converts.
 * `convert` returns a fragment of the cluster's attributes (one property can
 * feed several attributes, e.g. `aenergy` -> cumulative + periodic energy).
 * `kinds` restricts a row to specific component kinds (unset = all kinds);
 * the same property name can map differently per kind (a switch's `state` is
 * a boolean, a cover's is a movement string).
 */
const PROPERTY_MAP: {
  property: string;
  cluster: string;
  convert: (value: ShellyDataType) => ClusterState | undefined;
  kinds?: ComponentKind[];
  /** Only forwarded when the device's power metering is enabled. */
  metered?: boolean;
  throttled?: boolean;
}[] = [
  { property: 'state', cluster: 'onOff', convert: (v) => (typeof v === 'boolean' ? { onOff: v } : undefined), kinds: ['switch', 'dimmer'] },
  { property: 'brightness', cluster: 'levelControl', convert: (v) => (isValidNumber(v, 0, 100) ? { currentLevel: levelFromBrightness(v) } : undefined), kinds: ['dimmer'] },
  { property: 'current_pos', cluster: 'windowCovering', convert: (v) => (isValidNumber(v, 0, 100) ? { currentPositionLiftPercent100ths: liftFromPosition(v) } : undefined), kinds: ['cover'] },
  { property: 'state', cluster: 'windowCovering', convert: (v) => (typeof v === 'string' ? { operationalStatus: OPERATIONAL_STATUS[v] ?? OPERATIONAL_STOPPED } : undefined), kinds: ['cover'] },
  { property: 'apower', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { activePower: milli(v) } : undefined), metered: true },
  { property: 'voltage', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { voltage: milli(v) } : undefined), metered: true },
  { property: 'current', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { activeCurrent: milli(v) } : undefined), metered: true },
  { property: 'aenergy', cluster: 'electricalEnergyMeasurement', convert: energyFragment('Imported'), metered: true, throttled: true },
  { property: 'ret_aenergy', cluster: 'electricalEnergyMeasurement', convert: energyFragment('Exported'), metered: true, throttled: true },
];

/** Per-kind property lookup, so a kind only ever sees its own rows. */
const PROPERTY_MAPS: Record<ComponentKind, Map<string, (typeof PROPERTY_MAP)[number]>> = {
  switch: new Map(),
  cover: new Map(),
  dimmer: new Map(),
};
for (const entry of PROPERTY_MAP) {
  for (const kind of entry.kinds ?? (Object.keys(PROPERTY_MAPS) as ComponentKind[])) {
    PROPERTY_MAPS[kind].set(entry.property, entry);
  }
}

/**
 * Part ids must avoid ':' and embed the identity token: a type change then
 * rotates the endpoint identity (id, uniqueId, endpoint number), so
 * controllers see a clean remove+add instead of a half-updated device -
 * Apple Home leaves accessories in an uneditable state when a device
 * reappears with the same uniqueId but a different device type.
 */
const partIdFor = (component: ShellyComponent, token: PartToken): string => `${component.id.replace(':', '-')}-${token}`;

export interface MappedComponent {
  component: ShellyComponent;
  kind: ComponentKind;
}

/** The components this plugin can expose, in device order. */
export function mappedComponents(device: ShellyDevice): MappedComponent[] {
  const mapped: MappedComponent[] = [];
  for (const [, component] of device) {
    if (isSwitchComponent(component)) mapped.push({ component, kind: 'switch' });
    else if (isCoverComponent(component)) mapped.push({ component, kind: 'cover' });
    // Light components without brightness (and Rgb/Rgbw/Cct color channels)
    // are not mapped yet - see the README support matrix.
    else if (isLightComponent(component) && component.name === 'Light' && component.hasProperty('brightness')) mapped.push({ component, kind: 'dimmer' });
  }
  return mapped;
}

/** The part identity token: configurable accessory type for switches, the fixed kind otherwise. */
function partTokenFor(platform: ShellyMatterPlatform, device: ShellyDevice, { component, kind }: MappedComponent): PartToken {
  return kind === 'switch' ? resolveConfiguredAccessoryType(platform.config, device.id, device.host, component.index) : kind;
}

function meteringEnabled(platform: ShellyMatterPlatform, device: ShellyDevice): boolean {
  return configForDevice(platform.config, device.id, device.host)?.powerMetering !== false;
}

function visibleComponents(platform: ShellyMatterPlatform, device: ShellyDevice): MappedComponent[] {
  const entry = configForDevice(platform.config, device.id, device.host);
  return mappedComponents(device).filter(({ component }) => channelConfig(entry, component.index)?.hidden !== true);
}

function matterDeviceTypeFor(platform: ShellyMatterPlatform, token: PartToken) {
  if (token === 'cover') return platform.matter.deviceTypes.WindowCovering;
  if (token === 'dimmer') return platform.matter.deviceTypes.DimmableLight;
  if (token === 'switch') return platform.matter.deviceTypes.OnOffSwitch;
  if (token === 'light') return platform.matter.deviceTypes.OnOffLight;
  return platform.matter.deviceTypes.OnOffOutlet;
}

/** Initial cluster state for one component, with electrical clusters when the component meters. */
function clustersFor(component: ShellyComponent, kind: ComponentKind, metering: boolean): Record<string, ClusterState> {
  // The primary cluster must always exist (it is the registration-verify
  // probe and carries the mandatory attributes); seed it and let the map's
  // own rows overwrite when the device reports.
  const clusters: Record<string, ClusterState> = kind === 'cover'
    ? { windowCovering: { currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0, operationalStatus: OPERATIONAL_STOPPED } }
    : { onOff: { onOff: false } };
  if (kind === 'dimmer') clusters.levelControl = { currentLevel: 254 };
  for (const entry of PROPERTY_MAPS[kind].values()) {
    if ((entry.metered && !metering) || !component.hasProperty(entry.property)) continue;
    const fragment = entry.convert(component.getValue(entry.property));
    if (fragment === undefined) continue;
    Object.assign((clusters[entry.cluster] ??= {}), fragment);
  }
  // A cover that is not moving should target where it is.
  if (kind === 'cover') clusters.windowCovering.targetPositionLiftPercent100ths = clusters.windowCovering.currentPositionLiftPercent100ths;
  return clusters;
}

/**
 * Handlers resolve the component at invocation time so they also work on
 * accessories re-registered from the cache before the device has connected.
 */
function handlersFor(platform: ShellyMatterPlatform, uuid: string, deviceId: string, componentId: string, partId: string, kind: ComponentKind) {
  const resolve = (action: string): ShellyComponent | undefined => {
    const component = platform.shellyComponent(deviceId, componentId);
    if (!component) platform.log.warn(`Shelly ${deviceId} is not connected - cannot ${action} ${componentId}.`);
    return component;
  };

  if (kind === 'cover') {
    const cover = (action: string) => {
      const component = resolve(action);
      return isCoverComponent(component) ? component : undefined;
    };
    // The WindowCovering behavior updates Matter state itself after a handler
    // succeeds, so no optimistic push is needed here.
    return {
      windowCovering: {
        upOrOpen: () => cover('open')?.Open(),
        downOrClose: () => cover('close')?.Close(),
        stopMotion: () => cover('stop')?.Stop(),
        goToLiftPercentage: (request: { liftPercent100thsValue: number }) => cover('position')?.GoToPosition(positionFromLift(request.liftPercent100thsValue)),
      },
    };
  }

  const setOnOff = (on: boolean): void => {
    const component = resolve(`switch ${on ? 'on' : 'off'}`);
    if (!isSwitchComponent(component) && !isLightComponent(component)) return;
    // Fire the RPC and update Matter state optimistically; the device's
    // status notification reconciles the real state moments later.
    if (on) component.On();
    else component.Off();
    void platform.matter.updateAccessoryState(uuid, 'onOff', { onOff: on }, partId);
  };
  const handlers: Record<string, Record<string, (request?: never) => void>> = {
    onOff: {
      on: () => setOnOff(true),
      off: () => setOnOff(false),
    },
  };
  if (kind === 'dimmer') {
    // The LevelControl behavior updates Matter state itself after the handler.
    const setLevel = (request: { level: number }): void => {
      const component = resolve('dim');
      if (isLightComponent(component)) component.Level(brightnessFromLevel(request.level));
    };
    handlers.levelControl = { moveToLevel: setLevel as never, moveToLevelWithOnOff: setLevel as never };
  }
  return handlers;
}

/** Serializable context stored with the accessory; enough to rebuild it from the cache. */
interface ShellyAccessoryContext {
  deviceId: string;
  /** The device-level display name (split accessories carry channel names in displayName). */
  deviceName?: string;
  /**
   * Rotation generation, embedded in the identity seed and bumped on every
   * composition change. Guarantees a rotation NEVER lands on a previously
   * used identity: matter.js persists endpoint numbers per endpoint id, so a
   * reverted composition would otherwise resurrect endpoints a controller
   * recently deleted - Apple Home stalls on such reappearances. Generation 0
   * adds no seed suffix, so pre-generation identities are unchanged.
   */
  generation?: number;
  partTypes: Record<string, PartToken>;
  partComponents: Record<string, string>;
}

/** The seed suffix for a rotation generation (empty for generation 0 - legacy identities stay stable). */
const generationSuffix = (generation: number): string => (generation > 0 ? `|g${generation}` : '');

/** The component kind a part identity token belongs to. */
const kindOfToken = (token: PartToken): ComponentKind => (token === 'cover' || token === 'dimmer' ? token : 'switch');

interface TypedComponent extends MappedComponent {
  token: PartToken;
}

/** One composed accessory (BridgedNode parent + one part per given component). */
function buildOneAccessory(
  platform: ShellyMatterPlatform,
  device: ShellyDevice,
  deviceName: string,
  generation: number,
  typed: TypedComponent[],
  seed: string,
  displayName: string,
  partNameFor: (component: ShellyComponent) => string,
  metering: boolean,
): MatterAccessory {
  const uuid = platform.matter.uuid.generate(seed);
  const partTypes: Record<string, PartToken> = {};
  const partComponents: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = typed.map(({ component, kind, token }) => {
    const partId = partIdFor(component, token);
    partTypes[partId] = token;
    partComponents[partId] = component.id;
    return {
      id: partId,
      displayName: partNameFor(component),
      deviceType: matterDeviceTypeFor(platform, token),
      clusters: clustersFor(component, kind, metering),
      handlers: handlersFor(platform, uuid, device.id, component.id, partId, kind),
    };
  });
  const context: ShellyAccessoryContext = { deviceId: device.id, deviceName, generation, partTypes, partComponents };
  return {
    UUID: uuid,
    displayName,
    serialNumber: device.mac,
    manufacturer: 'Shelly',
    model: device.model,
    firmwareRevision: device.firmware,
    context,
    deviceType: platform.matter.deviceTypes.BridgedNode,
    parts,
  };
}

/**
 * Builds the MatterAccessories for a Shelly device (empty if it has no
 * visible supported components). EVERY accessory is a BridgedNode parent
 * with parts - matching how matterbridge exposes devices (single-channel
 * included). Apple hubs are only known to behave with this composed shape;
 * flat typed endpoints under the aggregator are the one structure the
 * reference bridge never produces.
 *
 * By default a device is ONE accessory with a part per visible channel.
 * With `splitChannels`, each channel becomes its own accessory (Apple Home
 * assigns rooms per accessory - separated tiles of one accessory always
 * move rooms together, so multi-room devices need the split).
 */
export function buildShellyAccessories(platform: ShellyMatterPlatform, device: ShellyDevice, generation = 0): MatterAccessory[] {
  const visible = visibleComponents(platform, device);
  if (visible.length === 0) return [];

  const entry = configForDevice(platform.config, device.id, device.host);
  const displayName = entry?.name ?? device.name;
  const metering = meteringEnabled(platform, device);
  // Each component's token is resolved exactly once and feeds both the
  // identity seed and the part construction, so the two cannot drift.
  const typed: TypedComponent[] = visible.map((mapped) => ({ ...mapped, token: partTokenFor(platform, device, mapped) }));
  // Multi-channel names get an index suffix (tiles are renamed in the Home app).
  const channelName = (component: ShellyComponent) => (visible.length === 1 ? displayName : `${displayName} ${component.index + 1}`);

  // Identity embeds the effective composition (visible channels and their
  // types) so ANY composition change - retyping a channel, hiding one,
  // toggling splitChannels - rotates the accessory identity, parent
  // included. Controllers then see a clean remove+add; a parent that keeps
  // its identity while its children change becomes an uneditable
  // "Not Supported" husk in Apple Home.
  if (splitChannelsEnabled(entry) && visible.length > 1) {
    return typed.map((one) => {
      // Split accessories can carry a per-channel name (grouped parts cannot
      // reach the Home app with one, so channel names only apply here).
      const name = channelConfig(entry, one.component.index)?.name ?? channelName(one.component);
      return buildOneAccessory(platform, device, displayName, generation, [one], `${device.id}|split|${one.component.index}:${one.token}${generationSuffix(generation)}`, name, () => name, metering);
    });
  }
  const seed = `${device.id}|bridge|${typed.map(({ component, token }) => `${component.index}:${token}`).join(',')}${generationSuffix(generation)}`;
  return [buildOneAccessory(platform, device, displayName, generation, typed, seed, displayName, channelName, metering)];
}

/** The device id a cached accessory belongs to, if it is one of ours. */
export function cachedAccessoryDeviceId(cached: MatterAccessory): string | undefined {
  const context = cached.context as Partial<ShellyAccessoryContext> | undefined;
  return typeof context?.deviceId === 'string' ? context.deviceId : undefined;
}

/** The component kind implied by a component id ('switch:0', 'cover:0', ...). */
const KIND_BY_COMPONENT_PREFIX: Record<string, ComponentKind> = {
  switch: 'switch',
  relay: 'switch',
  cover: 'cover',
  roller: 'cover',
  light: 'dimmer',
};

interface CachedComponent {
  componentId: string;
  index: number;
  kind: ComponentKind;
  token: PartToken;
  /** Cluster snapshot carried from the cached part, so shells keep the same cluster shape. */
  clusters: Record<string, ClusterState>;
}

/**
 * The carried cluster snapshot for a shell: strips metering clusters when
 * metering is off, and seeds periodic-energy attributes alongside carried
 * cumulative ones - features compose at registration time, so PeriodicEnergy
 * must be present in the (pre-online) shell for the live per-minute updates
 * to apply. Never mutates the cached objects.
 */
function clustersForMetering(clusters: Record<string, ClusterState>, metering: boolean): Record<string, ClusterState> {
  const result: Record<string, ClusterState> = {};
  for (const [cluster, attributes] of Object.entries(clusters)) {
    if (!metering && (cluster === 'electricalPowerMeasurement' || cluster === 'electricalEnergyMeasurement')) continue;
    result[cluster] = attributes;
  }
  const eem = result.electricalEnergyMeasurement;
  if (eem !== undefined) {
    const seeded = { ...eem };
    if ('cumulativeEnergyImported' in seeded && !('periodicEnergyImported' in seeded)) seeded.periodicEnergyImported = { energy: 0 };
    if ('cumulativeEnergyExported' in seeded && !('periodicEnergyExported' in seeded)) seeded.periodicEnergyExported = { energy: 0 };
    result.electricalEnergyMeasurement = seeded;
  }
  return result;
}

/** One expected shell accessory built from cached knowledge instead of a live device. */
function shellFromCache(
  platform: ShellyMatterPlatform,
  deviceId: string,
  deviceName: string,
  generation: number,
  template: MatterAccessory,
  components: CachedComponent[],
  seed: string,
  displayName: string,
  partNameFor: (component: CachedComponent) => string,
  metering: boolean,
): MatterAccessory {
  const uuid = platform.matter.uuid.generate(seed);
  const partTypes: Record<string, PartToken> = {};
  const partComponents: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = components.map((component) => {
    const partId = `${component.componentId.replace(':', '-')}-${component.token}`;
    partTypes[partId] = component.token;
    partComponents[partId] = component.componentId;
    return {
      id: partId,
      displayName: partNameFor(component),
      deviceType: matterDeviceTypeFor(platform, component.token),
      clusters: clustersForMetering(component.clusters, metering),
      handlers: handlersFor(platform, uuid, deviceId, component.componentId, partId, component.kind),
    };
  });
  const context: ShellyAccessoryContext = { deviceId, deviceName, generation, partTypes, partComponents };
  return {
    UUID: uuid,
    displayName,
    serialNumber: template.serialNumber,
    manufacturer: template.manufacturer,
    model: template.model,
    firmwareRevision: template.firmwareRevision,
    context,
    deviceType: platform.matter.deviceTypes.BridgedNode,
    parts,
  };
}

/**
 * Rebuilds a device's EXPECTED accessories from its cached accessories plus
 * the current config - the same composition rules as buildShellyAccessories,
 * but with components reconstructed from the cached contexts and cluster
 * snapshots carried over. This lets the platform apply composition changes
 * (splitChannels, type changes, hidden channels) at startup, BEFORE the
 * Matter node goes online: paired controllers then only ever see the final
 * structure. Rotating live on a commissioned bridge desyncs Apple Home (the
 * bridge record is rebuilt, devices vanish until the hub reboots).
 *
 * Returns undefined for foreign/corrupt cache entries.
 */
export function expectedShellsFromCache(platform: ShellyMatterPlatform, deviceId: string, cachedList: MatterAccessory[]): { shells: MatterAccessory[]; generation: number } | undefined {
  const entry = configForDevice(platform.config, deviceId);
  const validToken = (token: unknown): PartToken =>
    (token === 'cover' || token === 'dimmer' || ACCESSORY_TYPES.includes(token as AccessoryType) ? (token as PartToken) : defaultAccessoryType(deviceId));

  const components = new Map<string, CachedComponent>();
  let template: MatterAccessory | undefined;
  let cachedDeviceName: string | undefined;
  let cachedGeneration = 0;
  for (const cached of cachedList) {
    const context = cached.context as Partial<ShellyAccessoryContext> | undefined;
    if (!context?.partComponents || !context.partTypes) continue;
    template ??= cached;
    cachedDeviceName ??= context.deviceName;
    if (typeof context.generation === 'number' && context.generation > cachedGeneration) cachedGeneration = context.generation;
    for (const part of cached.parts ?? []) {
      const componentId = context.partComponents[part.id];
      if (componentId === undefined || components.has(componentId)) continue;
      const match = componentId.match(/^([a-z]+):?(\d+)$/i);
      const kind = match ? KIND_BY_COMPONENT_PREFIX[match[1].toLowerCase()] : undefined;
      if (!match || !kind) continue;
      const index = Number(match[2]);
      const token = kind === 'switch' ? resolveConfiguredAccessoryType(platform.config, deviceId, undefined, index) : kind;
      components.set(componentId, { componentId, index, kind, token: validToken(token), clusters: part.clusters });
    }
  }
  if (!template || components.size === 0) return undefined;

  // Base name: config wins; else the recorded device name; else a grouped
  // accessory's own display name (pre-deviceName caches are always grouped).
  const deviceName = entry?.name ?? cachedDeviceName ?? template.displayName;
  const metering = entry?.powerMetering !== false;
  const visible = [...components.values()]
    .filter((component) => channelConfig(entry, component.index)?.hidden !== true)
    .sort((a, b) => a.index - b.index);
  if (visible.length === 0) return { shells: [], generation: cachedGeneration };
  const channelName = (component: CachedComponent) => (visible.length === 1 ? deviceName : `${deviceName} ${component.index + 1}`);

  const buildAt = (generation: number): MatterAccessory[] => {
    if (splitChannelsEnabled(entry) && visible.length > 1) {
      return visible.map((one) => {
        const name = channelConfig(entry, one.index)?.name ?? channelName(one);
        return shellFromCache(platform, deviceId, deviceName, generation, template!, [one], `${deviceId}|split|${one.index}:${one.token}${generationSuffix(generation)}`, name, () => name, metering);
      });
    }
    const seed = `${deviceId}|bridge|${visible.map((component) => `${component.index}:${component.token}`).join(',')}${generationSuffix(generation)}`;
    return [shellFromCache(platform, deviceId, deviceName, generation, template!, visible, seed, deviceName, channelName, metering)];
  };

  // Build at the cached generation; if the composition changed, rebuild one
  // generation up so the rotation lands on a NEVER previously used identity
  // (a revert would otherwise resurrect endpoints controllers just deleted).
  const atCachedGeneration = buildAt(cachedGeneration);
  const cachedUuids = new Set(cachedList.map((cached) => cached.UUID));
  const unchanged = atCachedGeneration.length === cachedUuids.size && atCachedGeneration.every((shell) => cachedUuids.has(shell.UUID));
  if (unchanged) return { shells: atCachedGeneration, generation: cachedGeneration };
  return { shells: buildAt(cachedGeneration + 1), generation: cachedGeneration + 1 };
}

/**
 * Structural signature to decide whether a live device matches its cached
 * registration. Compared only in-memory within one process, never persisted.
 * The root shape is constant (BridgedNode, no root clusters) - only the name
 * and the parts vary.
 */
export function accessorySignature(accessory: MatterAccessory): string {
  const typeName = (deviceType: unknown): string => (deviceType as { name?: string })?.name ?? String(deviceType);
  return JSON.stringify({
    name: accessory.displayName,
    // Firmware is part of the signature so a Shelly OTA re-registers the
    // accessory in place (same identity) and controllers see the new version.
    firmware: accessory.firmwareRevision,
    parts: (accessory.parts ?? []).map((part) => ({
      id: part.id,
      name: part.displayName,
      type: typeName(part.deviceType),
      clusters: Object.keys(part.clusters).sort(),
    })),
  });
}

/**
 * The accessory's own parts resolved to live components. Driven by the
 * registered shape (context), not by re-deriving from config, so a split
 * accessory only ever touches its own channel.
 */
function accessoryParts(device: ShellyDevice, accessory: MatterAccessory): { partId: string; component: ShellyComponent; kind: ComponentKind }[] {
  const context = accessory.context as Partial<ShellyAccessoryContext> | undefined;
  const resolved: { partId: string; component: ShellyComponent; kind: ComponentKind }[] = [];
  for (const part of accessory.parts ?? []) {
    const componentId = context?.partComponents?.[part.id];
    const component = componentId !== undefined ? device.getComponent(componentId) : undefined;
    if (!component) continue;
    const token = context?.partTypes?.[part.id];
    resolved.push({ partId: part.id, component, kind: kindOfToken((token ?? 'light') as PartToken) });
  }
  return resolved;
}

/** Pushes the device's current state into an already-registered accessory. */
export function pushCurrentState(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  for (const { partId, component, kind } of accessoryParts(device, accessory)) {
    for (const [cluster, attributes] of Object.entries(clustersFor(component, kind, metering))) {
      void platform.matter.updateAccessoryState(accessory.UUID, cluster, attributes, partId);
    }
  }
}

/** Subscribes to component updates and forwards them to the Matter accessory state. */
export function attachComponentUpdates(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  const lastEnergyPush = new Map<string, number>();

  for (const { partId, component, kind } of accessoryParts(device, accessory)) {
    const propertyMap = PROPERTY_MAPS[kind];

    component.on('update', (_componentId: string, property: string, value: ShellyDataType) => {
      const entry = propertyMap.get(property);
      if (!entry || (entry.metered && !metering)) return;
      // Check the throttle window before converting so suppressed energy
      // updates cost nothing; stamp only after a successful conversion.
      const throttleKey = entry.throttled ? `${component.id}:${property}` : undefined;
      if (throttleKey !== undefined && Date.now() - (lastEnergyPush.get(throttleKey) ?? 0) < ENERGY_PUSH_MIN_INTERVAL_MS) return;
      const fragment = entry.convert(value);
      if (fragment === undefined) return;
      if (throttleKey !== undefined) lastEnergyPush.set(throttleKey, Date.now());
      void platform.matter.updateAccessoryState(accessory.UUID, entry.cluster, fragment, partId);
    });
  }
}
