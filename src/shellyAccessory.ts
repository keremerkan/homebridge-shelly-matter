import type { MatterAccessory } from 'homebridge';

// Not re-exported from 'homebridge', so derive the part type from MatterAccessory.
type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];

import { ACCESSORY_TYPES, type AccessoryType, channelConfig, configForDevice, defaultAccessoryType } from './deviceConfig.js';
import type { ShellyMatterPlatform } from './platform.js';
import { isSwitchComponent, type ShellyComponent, type ShellySwitchComponent } from './shelly/shellyComponent.js';
import type { ShellyDevice } from './shelly/shellyDevice.js';
import type { ShellyData, ShellyDataType } from './shelly/shellyTypes.js';
import { isValidNumber, isValidObject } from './shelly/utils/index.js';

// Matter electrical measurement attributes use milli-units: mV, mA, mW, mWh.
const milli = (value: number): number => Math.round(value * 1000);

// Energy updates are pushed to controllers unthrottled (CumulativeEnergyMeasured
// events), so Homebridge documents a 30-60s cadence. Shelly notifies more often.
const ENERGY_PUSH_MIN_INTERVAL_MS = 30_000;

type ClusterState = Record<string, unknown>;

/**
 * The Shelly-property -> Matter-attribute map, used both to build the initial
 * cluster snapshot at registration and to forward live updates - one table so
 * the two can never disagree about what is metered and how it converts.
 */
const PROPERTY_MAP: {
  property: string;
  cluster: string;
  attribute: string;
  convert: (value: ShellyDataType) => unknown;
  throttled?: boolean;
}[] = [
  { property: 'state', cluster: 'onOff', attribute: 'onOff', convert: (v) => (typeof v === 'boolean' ? v : undefined) },
  { property: 'apower', cluster: 'electricalPowerMeasurement', attribute: 'activePower', convert: (v) => (isValidNumber(v, 0) ? milli(v) : undefined) },
  { property: 'voltage', cluster: 'electricalPowerMeasurement', attribute: 'voltage', convert: (v) => (isValidNumber(v, 0) ? milli(v) : undefined) },
  { property: 'current', cluster: 'electricalPowerMeasurement', attribute: 'activeCurrent', convert: (v) => (isValidNumber(v, 0) ? milli(v) : undefined) },
  {
    property: 'aenergy',
    cluster: 'electricalEnergyMeasurement',
    attribute: 'cumulativeEnergyImported',
    convert: (v) => (isValidObject(v) && isValidNumber((v as ShellyData).total, 0) ? { energy: milli((v as ShellyData).total as number) } : undefined),
    throttled: true,
  },
  {
    property: 'ret_aenergy',
    cluster: 'electricalEnergyMeasurement',
    attribute: 'cumulativeEnergyExported',
    convert: (v) => (isValidObject(v) && isValidNumber((v as ShellyData).total, 0) ? { energy: milli((v as ShellyData).total as number) } : undefined),
    throttled: true,
  },
];

/**
 * Part ids must avoid ':' and embed the accessory type: a type change then
 * rotates the endpoint identity (id, uniqueId, endpoint number), so
 * controllers see a clean remove+add instead of a half-updated device -
 * Apple Home leaves accessories in an uneditable state when a device
 * reappears with the same uniqueId but a different device type.
 */
const partIdFor = (component: ShellyComponent, type: AccessoryType): string => `${component.id.replace(':', '-')}-${type}`;

export function switchComponents(device: ShellyDevice): ShellySwitchComponent[] {
  const components: ShellySwitchComponent[] = [];
  for (const [, component] of device) {
    if (isSwitchComponent(component)) components.push(component);
  }
  return components;
}

/** Channel setting wins over the device setting, which wins over the kind-based default. */
function resolveAccessoryType(platform: ShellyMatterPlatform, device: ShellyDevice, component: ShellyComponent): AccessoryType {
  const entry = configForDevice(platform.config, device.id, device.host);
  const channel = channelConfig(entry, component.index);
  if (channel?.accessoryType && ACCESSORY_TYPES.includes(channel.accessoryType)) return channel.accessoryType;
  if (entry?.accessoryType && ACCESSORY_TYPES.includes(entry.accessoryType)) return entry.accessoryType;
  return defaultAccessoryType(device.id);
}

function meteringEnabled(platform: ShellyMatterPlatform, device: ShellyDevice): boolean {
  return configForDevice(platform.config, device.id, device.host)?.powerMetering !== false;
}

function visibleComponents(platform: ShellyMatterPlatform, device: ShellyDevice): ShellySwitchComponent[] {
  const entry = configForDevice(platform.config, device.id, device.host);
  return switchComponents(device).filter((component) => channelConfig(entry, component.index)?.hidden !== true);
}

function matterDeviceTypeFor(platform: ShellyMatterPlatform, accessoryType: AccessoryType) {
  if (accessoryType === 'switch') return platform.matter.deviceTypes.OnOffSwitch;
  if (accessoryType === 'light') return platform.matter.deviceTypes.OnOffLight;
  return platform.matter.deviceTypes.OnOffOutlet;
}

/** Initial cluster state for one switch component, with electrical clusters when the component meters. */
function clustersFor(component: ShellyComponent, metering: boolean): Record<string, ClusterState> {
  const clusters: Record<string, ClusterState> = { onOff: { onOff: component.getValue('state') === true } };
  if (!metering) return clusters;
  for (const entry of PROPERTY_MAP) {
    if (entry.cluster === 'onOff' || !component.hasProperty(entry.property)) continue;
    const value = entry.convert(component.getValue(entry.property));
    if (value === undefined) continue;
    (clusters[entry.cluster] ??= {})[entry.attribute] = value;
  }
  return clusters;
}

/**
 * Handlers resolve the component at invocation time so they also work on
 * accessories re-registered from the cache before the device has connected.
 */
function handlersFor(platform: ShellyMatterPlatform, uuid: string, deviceId: string, componentId: string, partId?: string) {
  const setOnOff = (on: boolean): void => {
    const component = platform.shellySwitchComponent(deviceId, componentId);
    if (!component) {
      platform.log.warn(`Shelly ${deviceId} is not connected - cannot switch ${componentId} ${on ? 'on' : 'off'}.`);
      return;
    }
    // Fire the RPC and update Matter state optimistically; the device's
    // WebSocket status notification reconciles the real state moments later.
    if (on) component.On();
    else component.Off();
    void platform.matter.updateAccessoryState(uuid, 'onOff', { onOff: on }, partId);
  };
  return {
    onOff: {
      on: () => setOnOff(true),
      off: () => setOnOff(false),
    },
  };
}

/** Serializable context stored with the accessory; enough to rebuild it from the cache. */
interface ShellyAccessoryContext {
  deviceId: string;
  partTypes: Record<string, AccessoryType>;
  partComponents: Record<string, string>;
}

/**
 * Builds the MatterAccessory for a Shelly device, or undefined if the device
 * has no visible supported components. EVERY device becomes a BridgedNode
 * parent with one part per visible channel - matching how matterbridge
 * exposes devices (single-channel included). Apple hubs are only known to
 * behave with this composed shape; flat typed endpoints under the aggregator
 * are the one structure the reference bridge never produces.
 */
export function buildShellyAccessory(platform: ShellyMatterPlatform, device: ShellyDevice): MatterAccessory | undefined {
  const visible = visibleComponents(platform, device);
  if (visible.length === 0) return undefined;

  const entry = configForDevice(platform.config, device.id, device.host);
  const displayName = entry?.name ?? device.name;
  const metering = meteringEnabled(platform, device);
  // Identity embeds the effective composition (visible channels and their
  // types) so ANY composition change - retyping a channel, hiding one -
  // rotates the accessory identity, parent included. Controllers then see a
  // clean remove+add; a parent that keeps its identity while its children
  // change becomes an uneditable "Not Supported" husk in Apple Home.
  const uuid = platform.matter.uuid.generate(`${device.id}|bridge|${visible.map((component) => `${component.index}:${resolveAccessoryType(platform, device, component)}`).join(',')}`);
  const base = {
    UUID: uuid,
    displayName,
    serialNumber: device.mac,
    manufacturer: 'Shelly',
    model: device.model,
    firmwareRevision: device.firmware,
    context: {},
  };

  const partTypes: Record<string, AccessoryType> = {};
  const partComponents: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = visible.map((component) => {
    const type = resolveAccessoryType(platform, device, component);
    const partId = partIdFor(component, type);
    partTypes[partId] = type;
    partComponents[partId] = component.id;
    return {
      id: partId,
      // Single-channel devices keep the plain device name on their sole part;
      // multi-channel parts get an index suffix (channel tiles are renamed in
      // the Home app).
      displayName: visible.length === 1 ? displayName : `${displayName} ${component.index + 1}`,
      deviceType: matterDeviceTypeFor(platform, type),
      clusters: clustersFor(component, metering),
      handlers: handlersFor(platform, uuid, device.id, component.id, partId),
    };
  });
  const context: ShellyAccessoryContext = { deviceId: device.id, partTypes, partComponents };
  return {
    ...base,
    context,
    deviceType: platform.matter.deviceTypes.BridgedNode,
    parts,
  };
}

/** The device id a cached accessory belongs to, if it is one of ours. */
export function cachedAccessoryDeviceId(cached: MatterAccessory): string | undefined {
  const context = cached.context as Partial<ShellyAccessoryContext> | undefined;
  return typeof context?.deviceId === 'string' ? context.deviceId : undefined;
}

/**
 * Rebuilds a registrable accessory from a cached one: the cache preserves
 * everything except device types (not serializable) and handlers (functions),
 * which are restored from the context. Returns undefined for foreign entries.
 */
export function rebuildCachedAccessory(platform: ShellyMatterPlatform, cached: MatterAccessory): MatterAccessory | undefined {
  const context = cached.context as Partial<ShellyAccessoryContext> | undefined;
  if (!context?.deviceId || !context.partTypes || !context.partComponents) return undefined;
  const { deviceId, partTypes, partComponents } = context;
  const toDeviceType = (type: unknown) => matterDeviceTypeFor(platform, (ACCESSORY_TYPES.includes(type as AccessoryType) ? type : defaultAccessoryType(deviceId)) as AccessoryType);

  const parts = (cached.parts ?? []).map((part) => ({
    ...part,
    deviceType: toDeviceType(partTypes[part.id]),
    handlers: handlersFor(platform, cached.UUID, deviceId, partComponents[part.id], part.id),
  }));
  return { ...cached, deviceType: platform.matter.deviceTypes.BridgedNode, parts };
}

/** Structural signature to decide whether a live device matches its cached registration. */
export function accessorySignature(accessory: MatterAccessory): string {
  const typeName = (deviceType: unknown): string => (deviceType as { name?: string })?.name ?? String(deviceType);
  return JSON.stringify({
    name: accessory.displayName,
    type: typeName(accessory.deviceType),
    clusters: Object.keys(accessory.clusters ?? {}).sort(),
    parts: (accessory.parts ?? []).map((part) => ({
      id: part.id,
      name: part.displayName,
      type: typeName(part.deviceType),
      clusters: Object.keys(part.clusters).sort(),
    })),
  });
}

/** Every accessory is composed, so a component always maps to its part id. */
function partIdIn(platform: ShellyMatterPlatform, device: ShellyDevice, component: ShellyComponent): string {
  return partIdFor(component, resolveAccessoryType(platform, device, component));
}

/** Pushes the device's current state into an already-registered accessory. */
export function pushCurrentState(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  for (const component of visibleComponents(platform, device)) {
    const partId = partIdIn(platform, device, component);
    for (const [cluster, attributes] of Object.entries(clustersFor(component, metering))) {
      void platform.matter.updateAccessoryState(accessory.UUID, cluster, attributes, partId);
    }
  }
}

/** Subscribes to component updates and forwards them to the Matter accessory state. */
export function attachComponentUpdates(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  const lastEnergyPush = new Map<string, number>();

  for (const component of visibleComponents(platform, device)) {
    const partId = partIdIn(platform, device, component);

    component.on('update', (_componentId: string, property: string, value: ShellyDataType) => {
      const entry = PROPERTY_MAP.find((e) => e.property === property);
      if (!entry || (entry.cluster !== 'onOff' && !metering)) return;
      const converted = entry.convert(value);
      if (converted === undefined) return;
      if (entry.throttled) {
        const key = `${component.id}:${property}`;
        const now = Date.now();
        if (now - (lastEnergyPush.get(key) ?? 0) < ENERGY_PUSH_MIN_INTERVAL_MS) return;
        lastEnergyPush.set(key, now);
      }
      void platform.matter.updateAccessoryState(accessory.UUID, entry.cluster, { [entry.attribute]: converted }, partId);
    });
  }
}
