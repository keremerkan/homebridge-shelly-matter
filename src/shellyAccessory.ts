import type { MatterAccessory } from 'homebridge';

// Not re-exported from 'homebridge', so derive the part type from MatterAccessory.
type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];

import { ACCESSORY_TYPES, type AccessoryType, channelConfig, configForDevice, defaultAccessoryType, resolveAccessoryType as resolveConfiguredAccessoryType } from './deviceConfig.js';
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

/**
 * The Shelly-property -> Matter-attribute map, used both to build the initial
 * cluster snapshot at registration and to forward live updates - one table so
 * the two can never disagree about what is metered and how it converts.
 * `kinds` restricts a row to specific component kinds (unset = all kinds);
 * the same property name can map differently per kind (a switch's `state` is
 * a boolean, a cover's is a movement string).
 */
const PROPERTY_MAP: {
  property: string;
  cluster: string;
  attribute: string;
  convert: (value: ShellyDataType) => unknown;
  kinds?: ComponentKind[];
  /** Only forwarded when the device's power metering is enabled. */
  metered?: boolean;
  throttled?: boolean;
}[] = [
  { property: 'state', cluster: 'onOff', attribute: 'onOff', convert: (v) => (typeof v === 'boolean' ? v : undefined), kinds: ['switch', 'dimmer'] },
  { property: 'brightness', cluster: 'levelControl', attribute: 'currentLevel', convert: (v) => (isValidNumber(v, 0, 100) ? levelFromBrightness(v) : undefined), kinds: ['dimmer'] },
  { property: 'current_pos', cluster: 'windowCovering', attribute: 'currentPositionLiftPercent100ths', convert: (v) => (isValidNumber(v, 0, 100) ? liftFromPosition(v) : undefined), kinds: ['cover'] },
  { property: 'state', cluster: 'windowCovering', attribute: 'operationalStatus', convert: (v) => (typeof v === 'string' ? (OPERATIONAL_STATUS[v] ?? OPERATIONAL_STOPPED) : undefined), kinds: ['cover'] },
  { property: 'apower', cluster: 'electricalPowerMeasurement', attribute: 'activePower', convert: (v) => (isValidNumber(v, 0) ? milli(v) : undefined), metered: true },
  { property: 'voltage', cluster: 'electricalPowerMeasurement', attribute: 'voltage', convert: (v) => (isValidNumber(v, 0) ? milli(v) : undefined), metered: true },
  { property: 'current', cluster: 'electricalPowerMeasurement', attribute: 'activeCurrent', convert: (v) => (isValidNumber(v, 0) ? milli(v) : undefined), metered: true },
  {
    property: 'aenergy',
    cluster: 'electricalEnergyMeasurement',
    attribute: 'cumulativeEnergyImported',
    convert: (v) => (isValidObject(v) && isValidNumber((v as ShellyData).total, 0) ? { energy: milli((v as ShellyData).total as number) } : undefined),
    metered: true,
    throttled: true,
  },
  {
    property: 'ret_aenergy',
    cluster: 'electricalEnergyMeasurement',
    attribute: 'cumulativeEnergyExported',
    convert: (v) => (isValidObject(v) && isValidNumber((v as ShellyData).total, 0) ? { energy: milli((v as ShellyData).total as number) } : undefined),
    metered: true,
    throttled: true,
  },
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
    const value = entry.convert(component.getValue(entry.property));
    if (value === undefined) continue;
    (clusters[entry.cluster] ??= {})[entry.attribute] = value;
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
  partTypes: Record<string, PartToken>;
  partComponents: Record<string, string>;
}

/** The component kind a part identity token belongs to. */
const kindOfToken = (token: PartToken): ComponentKind => (token === 'cover' || token === 'dimmer' ? token : 'switch');

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
  // Each component's token is resolved exactly once and feeds both the
  // identity seed and the part construction, so the two cannot drift.
  const typed = visible.map((mapped) => ({ ...mapped, token: partTokenFor(platform, device, mapped) }));
  // Identity embeds the effective composition (visible channels and their
  // types) so ANY composition change - retyping a channel, hiding one -
  // rotates the accessory identity, parent included. Controllers then see a
  // clean remove+add; a parent that keeps its identity while its children
  // change becomes an uneditable "Not Supported" husk in Apple Home.
  const uuid = platform.matter.uuid.generate(`${device.id}|bridge|${typed.map(({ component, token }) => `${component.index}:${token}`).join(',')}`);

  const partTypes: Record<string, PartToken> = {};
  const partComponents: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = typed.map(({ component, kind, token }) => {
    const partId = partIdFor(component, token);
    partTypes[partId] = token;
    partComponents[partId] = component.id;
    return {
      id: partId,
      // Single-channel devices keep the plain device name on their sole part;
      // multi-channel parts get an index suffix (channel tiles are renamed in
      // the Home app).
      displayName: visible.length === 1 ? displayName : `${displayName} ${component.index + 1}`,
      deviceType: matterDeviceTypeFor(platform, token),
      clusters: clustersFor(component, kind, metering),
      handlers: handlersFor(platform, uuid, device.id, component.id, partId, kind),
    };
  });
  const context: ShellyAccessoryContext = { deviceId: device.id, partTypes, partComponents };
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
  const validToken = (token: unknown): PartToken =>
    (token === 'cover' || token === 'dimmer' || ACCESSORY_TYPES.includes(token as AccessoryType) ? (token as PartToken) : defaultAccessoryType(deviceId));

  const parts = (cached.parts ?? []).map((part) => {
    const token = validToken(partTypes[part.id]);
    return {
      ...part,
      deviceType: matterDeviceTypeFor(platform, token),
      handlers: handlersFor(platform, cached.UUID, deviceId, partComponents[part.id], part.id, kindOfToken(token)),
    };
  });
  return { ...cached, deviceType: platform.matter.deviceTypes.BridgedNode, parts };
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
    parts: (accessory.parts ?? []).map((part) => ({
      id: part.id,
      name: part.displayName,
      type: typeName(part.deviceType),
      clusters: Object.keys(part.clusters).sort(),
    })),
  });
}

/** Pushes the device's current state into an already-registered accessory. */
export function pushCurrentState(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  for (const mapped of visibleComponents(platform, device)) {
    const partId = partIdFor(mapped.component, partTokenFor(platform, device, mapped));
    for (const [cluster, attributes] of Object.entries(clustersFor(mapped.component, mapped.kind, metering))) {
      void platform.matter.updateAccessoryState(accessory.UUID, cluster, attributes, partId);
    }
  }
}

/** Subscribes to component updates and forwards them to the Matter accessory state. */
export function attachComponentUpdates(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  const lastEnergyPush = new Map<string, number>();

  for (const { component, kind } of visibleComponents(platform, device)) {
    const partId = partIdFor(component, partTokenFor(platform, device, { component, kind }));
    const propertyMap = PROPERTY_MAPS[kind];

    component.on('update', (_componentId: string, property: string, value: ShellyDataType) => {
      const entry = propertyMap.get(property);
      if (!entry || (entry.metered && !metering)) return;
      // Check the throttle window before converting so suppressed energy
      // updates cost nothing; stamp only after a successful conversion.
      const throttleKey = entry.throttled ? `${component.id}:${property}` : undefined;
      if (throttleKey !== undefined && Date.now() - (lastEnergyPush.get(throttleKey) ?? 0) < ENERGY_PUSH_MIN_INTERVAL_MS) return;
      const converted = entry.convert(value);
      if (converted === undefined) return;
      if (throttleKey !== undefined) lastEnergyPush.set(throttleKey, Date.now());
      void platform.matter.updateAccessoryState(accessory.UUID, entry.cluster, { [entry.attribute]: converted }, partId);
    });
  }
}
