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
export type ComponentKind = 'switch' | 'cover' | 'dimmer' | 'temperature' | 'humidity' | 'flood' | 'meter';

/** A part's identity token: the accessory type for switches, the kind otherwise. */
type PartToken = AccessoryType | 'cover' | 'dimmer' | 'temperature' | 'humidity' | 'flood' | 'meter';

/** Sensor kinds have no user-configurable type, no handlers, and never split. */
const SENSOR_KINDS = ['temperature', 'humidity', 'flood'] as const;
const isSensorKind = (kind: ComponentKind): boolean => (SENSOR_KINDS as readonly string[]).includes(kind);
const SENSOR_PART_LABEL: Record<string, string> = { temperature: 'Temperature', humidity: 'Humidity', flood: 'Water Leak' };

/** Kinds whose channels may split into separate accessories (sensors and meters never do). */
const isSplittableKind = (kind: ComponentKind): boolean => kind === 'switch' || kind === 'cover' || kind === 'dimmer';

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
  // Sensor kinds. Matter measures temperature and humidity in 0.01 units;
  // BooleanState's stateValue is TRUE when a leak is detected.
  { property: 'tC', cluster: 'temperatureMeasurement', convert: (v) => (isValidNumber(v, -273, 350) ? { measuredValue: Math.round(v * 100) } : undefined), kinds: ['temperature'] },
  { property: 'value', cluster: 'relativeHumidityMeasurement', convert: (v) => (isValidNumber(v, 0, 100) ? { measuredValue: Math.round(v * 100) } : undefined), kinds: ['humidity'] },
  { property: 'flood', cluster: 'booleanState', convert: (v) => (typeof v === 'boolean' ? { stateValue: v } : undefined), kinds: ['flood'] },
  // Meter (PowerMeter) components: em1/em/pm1 report plain W/V/A/Wh; the
  // vendored layer folds the em1data/emdata energy counters into the same
  // component. powerFactor is hundredths of a percent, frequency is mHz.
  { property: 'act_power', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v) ? { activePower: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'aprt_power', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { apparentPower: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'freq', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { frequency: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'pf', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, -1, 1) ? { powerFactor: Math.round(v * 10000) } : undefined), kinds: ['meter'], metered: true },
  { property: 'total_act_energy', cluster: 'electricalEnergyMeasurement', convert: (v) => (isValidNumber(v, 0) ? { cumulativeEnergyImported: { energy: milli(v) } } : undefined), kinds: ['meter'], metered: true, throttled: true },
  { property: 'total_act_ret_energy', cluster: 'electricalEnergyMeasurement', convert: (v) => (isValidNumber(v, 0) ? { cumulativeEnergyExported: { energy: milli(v) } } : undefined), kinds: ['meter'], metered: true, throttled: true },
];

/** Per-kind property lookup, so a kind only ever sees its own rows. */
const PROPERTY_MAPS: Record<ComponentKind, Map<string, (typeof PROPERTY_MAP)[number]>> = {
  switch: new Map(),
  cover: new Map(),
  dimmer: new Map(),
  temperature: new Map(),
  humidity: new Map(),
  flood: new Map(),
  meter: new Map(),
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

const BATTERY_CRITICAL_PCT = 10;
const BATTERY_WARNING_PCT = 20;

/** batPercentRemaining is in half-percent units; batChargeLevel 0=Ok 1=Warning 2=Critical. */
const powerSourceFragment = (level: ShellyDataType): ClusterState | undefined =>
  isValidNumber(level, 0, 100)
    ? { batPercentRemaining: Math.round(level * 2), batChargeLevel: level <= BATTERY_CRITICAL_PCT ? 2 : level <= BATTERY_WARNING_PCT ? 1 : 0 }
    : undefined;

/** Full PowerSource (Battery) state for the composed parent of a battery sensor. */
const powerSourceClusterFor = (battery: ShellyComponent): ClusterState => ({
  status: 1, // Active
  order: 0,
  description: 'Battery',
  batReplaceability: 1, // UserReplaceable
  batReplacementNeeded: false,
  ...(powerSourceFragment(battery.getValue('level')) ?? { batChargeLevel: 0 }),
});

/** Initial electrical cluster state contributed by a merged meter component. */
function meterClustersFor(meter: ShellyComponent, metering: boolean): Record<string, ClusterState> {
  const clusters: Record<string, ClusterState> = {};
  if (!metering) return clusters;
  for (const entry of PROPERTY_MAPS.meter.values()) {
    if (!meter.hasProperty(entry.property)) continue;
    const fragment = entry.convert(meter.getValue(entry.property));
    if (fragment === undefined) continue;
    Object.assign((clusters[entry.cluster] ??= {}), fragment);
  }
  return clusters;
}

/**
 * Meter part label: triphase 'em:' components are the total (index 0) and
 * phases A/B/C (1-3); every other meter family is numbered per channel.
 */
const METER_PHASES = ['Total', 'Phase A', 'Phase B', 'Phase C'];
const meterPartLabel = (componentId: string, index: number): string =>
  (componentId.startsWith('em:') && index >= 0 && index < METER_PHASES.length ? METER_PHASES[index] : `Meter ${index + 1}`);

/** The parent-level powerSource state of an accessory, if it carries one. */
const accessoryPowerSource = (accessory: MatterAccessory): ClusterState | undefined =>
  (accessory as { clusters?: Record<string, ClusterState> }).clusters?.powerSource;

export interface MappedComponent {
  component: ShellyComponent;
  kind: ComponentKind;
  /** A same-index PowerMeter component whose measurements merge onto this actuator's endpoint. */
  meter?: ShellyComponent;
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
  // PowerMeter components (em1/em/pm1, with the emdata counters folded in by
  // the protocol layer): a meter with a same-index actuator merges its
  // measurements onto that endpoint (the shape Apple Home fully supports -
  // live tile wattage on an outlet); meters without one become their own
  // ElectricalSensor part.
  let hasMeters = false;
  for (const [, component] of device) {
    if (component.name !== 'PowerMeter') continue;
    hasMeters = true;
    const actuator = mapped.find((m) => isSplittableKind(m.kind) && m.component.index === component.index && !m.meter);
    if (actuator) actuator.meter = component;
    else mapped.push({ component, kind: 'meter' });
  }
  // Environment sensors map only on sensor PRODUCTS (H&T, Flood, ...).
  // Relays and meters expose their INTERNAL device temperature under the
  // same component names - mapping those would sprout unwanted sensor
  // parts (and rotate identities).
  if (!hasMeters && mapped.length === 0) {
    for (const [, component] of device) {
      if (component.name === 'Temperature') mapped.push({ component, kind: 'temperature' });
      else if (component.name === 'Humidity') mapped.push({ component, kind: 'humidity' });
      else if (component.name === 'Flood') mapped.push({ component, kind: 'flood' });
    }
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
  const metering = entry?.powerMetering !== false;
  return mappedComponents(device).filter(({ component, kind }) => {
    if (kind === 'meter' && !metering) return false;
    return channelConfig(entry, component.index)?.hidden !== true;
  });
}

function matterDeviceTypeFor(platform: ShellyMatterPlatform, token: PartToken) {
  if (token === 'temperature') return platform.matter.deviceTypes.TemperatureSensor;
  if (token === 'humidity') return platform.matter.deviceTypes.HumiditySensor;
  if (token === 'flood') return platform.matter.deviceTypes.LeakSensor;
  if (token === 'meter') return platform.matter.deviceTypes.ElectricalSensor;
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
  const SENSOR_PRIMARY: Record<string, Record<string, ClusterState>> = {
    temperature: { temperatureMeasurement: { measuredValue: null } },
    humidity: { relativeHumidityMeasurement: { measuredValue: null } },
    flood: { booleanState: { stateValue: false } },
    meter: { electricalPowerMeasurement: { activePower: 0 } },
  };
  const clusters: Record<string, ClusterState> = SENSOR_PRIMARY[kind]
    ? Object.fromEntries(Object.entries(SENSOR_PRIMARY[kind]).map(([cluster, attributes]) => [cluster, { ...attributes }]))
    : kind === 'cover'
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
  // Sensors and meters are read-only: no commands, no handlers.
  if (isSensorKind(kind) || kind === 'meter') return undefined;
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
  /** Meter component merged onto a part's endpoint, by part id (EM-style devices). */
  partMeters?: Record<string, string>;
  partComponents: Record<string, string>;
}

/** The seed suffix for a rotation generation (empty for generation 0 - legacy identities stay stable). */
const generationSuffix = (generation: number): string => (generation > 0 ? `|g${generation}` : '');

/** The component kind a part identity token belongs to. */
const kindOfToken = (token: PartToken): ComponentKind => (token === 'cover' || token === 'dimmer' || token === 'meter' || isSensorKind(token as ComponentKind) ? (token as ComponentKind) : 'switch');

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
  parentClusters?: Record<string, ClusterState>,
): MatterAccessory {
  const uuid = platform.matter.uuid.generate(seed);
  const partTypes: Record<string, PartToken> = {};
  const partComponents: Record<string, string> = {};
  const partMeters: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = typed.map(({ component, kind, token, meter }) => {
    const partId = partIdFor(component, token);
    partTypes[partId] = token;
    partComponents[partId] = component.id;
    if (meter) partMeters[partId] = meter.id;
    return {
      id: partId,
      displayName: partNameFor(component),
      deviceType: matterDeviceTypeFor(platform, token),
      // A merged meter contributes its electrical clusters to the actuator's
      // own endpoint - the shape controllers (Apple Home included) support.
      clusters: { ...clustersFor(component, kind, metering), ...(meter ? meterClustersFor(meter, metering) : {}) },
      handlers: handlersFor(platform, uuid, device.id, component.id, partId, kind),
    };
  });
  const context: ShellyAccessoryContext = { deviceId: device.id, deviceName, generation, partTypes, partComponents, ...(Object.keys(partMeters).length ? { partMeters } : {}) };
  return {
    UUID: uuid,
    displayName,
    serialNumber: device.mac,
    manufacturer: 'Shelly',
    model: device.model,
    firmwareRevision: device.firmware,
    context,
    deviceType: platform.matter.deviceTypes.BridgedNode,
    ...(parentClusters ? { clusters: parentClusters } : {}),
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
  // Multi-channel names get an index suffix (tiles are renamed in the Home app);
  // sensor parts get their measurement label instead (their index is not a channel).
  const kindById = new Map(typed.map(({ component, kind }) => [component.id, kind]));
  const actuatorCount = typed.filter(({ kind }) => isSplittableKind(kind)).length;
  const channelName = (component: ShellyComponent) => {
    const kind = kindById.get(component.id);
    if (kind === 'meter') return `${displayName} ${meterPartLabel(component.id, component.index)}`;
    const label = SENSOR_PART_LABEL[kind ?? ''];
    if (label !== undefined) return `${displayName} ${label}`;
    return actuatorCount <= 1 ? displayName : `${displayName} ${component.index + 1}`;
  };
  // Battery state (H&T, Flood, ...) lives on the composed parent's PowerSource
  // cluster - the core composes the Battery feature from these attributes.
  const battery = device.getComponent('battery');
  const parentClusters = battery && typed.some(({ kind }) => isSensorKind(kind)) ? { powerSource: powerSourceClusterFor(battery) } : undefined;

  // Identity embeds the effective composition (visible channels and their
  // types) so ANY composition change - retyping a channel, hiding one,
  // toggling splitChannels - rotates the accessory identity, parent
  // included. Controllers then see a clean remove+add; a parent that keeps
  // its identity while its children change becomes an uneditable
  // "Not Supported" husk in Apple Home.
  // Sensor and meter parts never split into separate accessories (one
  // physical unit / measurement channels of one meter).
  if (splitChannelsEnabled(entry) && visible.length > 1 && typed.every(({ kind }) => isSplittableKind(kind))) {
    return typed.map((one) => {
      // Split accessories can carry a per-channel name (grouped parts cannot
      // reach the Home app with one, so channel names only apply here).
      const name = channelConfig(entry, one.component.index)?.name ?? channelName(one.component);
      return buildOneAccessory(platform, device, displayName, generation, [one], `${device.id}|split|${one.component.index}:${one.token}${generationSuffix(generation)}`, name, () => name, metering);
    });
  }
  const seed = `${device.id}|bridge|${typed.map(({ component, token }) => `${component.index}:${token}`).join(',')}${generationSuffix(generation)}`;
  return [buildOneAccessory(platform, device, displayName, generation, typed, seed, displayName, channelName, metering, parentClusters)];
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
  temperature: 'temperature',
  humidity: 'humidity',
  flood: 'flood',
  em1: 'meter',
  em: 'meter',
  pm1: 'meter',
  meter: 'meter',
  emeter: 'meter',
};

interface CachedComponent {
  componentId: string;
  index: number;
  kind: ComponentKind;
  token: PartToken;
  /** Meter component merged onto this part's endpoint, when the cache recorded one. */
  meterId?: string;
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
  parentClusters?: Record<string, ClusterState>,
): MatterAccessory {
  const uuid = platform.matter.uuid.generate(seed);
  const partTypes: Record<string, PartToken> = {};
  const partComponents: Record<string, string> = {};
  const partMeters: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = components.map((component) => {
    const partId = `${component.componentId.replace(':', '-')}-${component.token}`;
    partTypes[partId] = component.token;
    partComponents[partId] = component.componentId;
    if (component.meterId !== undefined) partMeters[partId] = component.meterId;
    return {
      id: partId,
      displayName: partNameFor(component),
      deviceType: matterDeviceTypeFor(platform, component.token),
      clusters: clustersForMetering(component.clusters, metering),
      handlers: handlersFor(platform, uuid, deviceId, component.componentId, partId, component.kind),
    };
  });
  const context: ShellyAccessoryContext = { deviceId, deviceName, generation, partTypes, partComponents, ...(Object.keys(partMeters).length ? { partMeters } : {}) };
  return {
    UUID: uuid,
    displayName,
    serialNumber: template.serialNumber,
    manufacturer: template.manufacturer,
    model: template.model,
    firmwareRevision: template.firmwareRevision,
    context,
    deviceType: platform.matter.deviceTypes.BridgedNode,
    ...(parentClusters ? { clusters: parentClusters } : {}),
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
export function expectedShellsFromCache(platform: ShellyMatterPlatform, deviceId: string, cachedList: MatterAccessory[], host?: string): { shells: MatterAccessory[]; generation: number } | undefined {
  const entry = configForDevice(platform.config, deviceId, host);
  const validToken = (token: unknown): PartToken =>
    (token === 'cover' || token === 'dimmer' || token === 'meter' || isSensorKind(token as ComponentKind) || ACCESSORY_TYPES.includes(token as AccessoryType) ? (token as PartToken) : defaultAccessoryType(deviceId));

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
      const match = componentId.match(/^(.+?):(\d+)$/) ?? componentId.match(/^([a-z_]+)$/i);
      const kind = match ? KIND_BY_COMPONENT_PREFIX[match[1].toLowerCase()] : undefined;
      if (!match || !kind) continue;
      const index = match[2] !== undefined ? Number(match[2]) : -1;
      const token = kind === 'switch' ? resolveConfiguredAccessoryType(platform.config, deviceId, host, index) : kind;
      components.set(componentId, { componentId, index, kind, token: validToken(token), clusters: part.clusters, meterId: context.partMeters?.[part.id] });
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
  const actuatorCount = visible.filter((component) => isSplittableKind(component.kind)).length;
  const channelName = (component: CachedComponent) => {
    if (component.kind === 'meter') return `${deviceName} ${meterPartLabel(component.componentId, component.index)}`;
    const label = SENSOR_PART_LABEL[component.kind];
    if (label !== undefined) return `${deviceName} ${label}`;
    return actuatorCount <= 1 ? deviceName : `${deviceName} ${component.index + 1}`;
  };
  const parentClusters = accessoryPowerSource(template) ? { powerSource: accessoryPowerSource(template)! } : undefined;

  const buildAt = (generation: number): MatterAccessory[] => {
    if (splitChannelsEnabled(entry) && visible.length > 1 && visible.every((component) => isSplittableKind(component.kind))) {
      return visible.map((one) => {
        const name = channelConfig(entry, one.index)?.name ?? channelName(one);
        return shellFromCache(platform, deviceId, deviceName, generation, template!, [one], `${deviceId}|split|${one.index}:${one.token}${generationSuffix(generation)}`, name, () => name, metering);
      });
    }
    const seed = `${deviceId}|bridge|${visible.map((component) => `${component.index}:${component.token}`).join(',')}${generationSuffix(generation)}`;
    return [shellFromCache(platform, deviceId, deviceName, generation, template!, visible, seed, deviceName, channelName, metering, parentClusters)];
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
    clusters: Object.keys((accessory as { clusters?: Record<string, ClusterState> }).clusters ?? {}).sort(),
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
function accessoryParts(device: ShellyDevice, accessory: MatterAccessory): { partId: string; component: ShellyComponent; kind: ComponentKind; meter?: ShellyComponent }[] {
  const context = accessory.context as Partial<ShellyAccessoryContext> | undefined;
  const resolved: { partId: string; component: ShellyComponent; kind: ComponentKind; meter?: ShellyComponent }[] = [];
  for (const part of accessory.parts ?? []) {
    const componentId = context?.partComponents?.[part.id];
    const component = componentId !== undefined ? device.getComponent(componentId) : undefined;
    if (!component) continue;
    const token = context?.partTypes?.[part.id];
    const meterId = context?.partMeters?.[part.id];
    const meter = meterId !== undefined ? device.getComponent(meterId) : undefined;
    resolved.push({ partId: part.id, component, kind: kindOfToken((token ?? 'light') as PartToken), meter });
  }
  return resolved;
}

/** Pushes the device's current state into an already-registered accessory. */
export function pushCurrentState(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  for (const { partId, component, kind, meter } of accessoryParts(device, accessory)) {
    for (const [cluster, attributes] of Object.entries(clustersFor(component, kind, metering))) {
      void platform.matter.updateAccessoryState(accessory.UUID, cluster, attributes, partId);
    }
    if (meter) {
      for (const [cluster, attributes] of Object.entries(meterClustersFor(meter, metering))) {
        void platform.matter.updateAccessoryState(accessory.UUID, cluster, attributes, partId);
      }
    }
  }
  // Battery lives on the composed parent, not on a part.
  if (accessoryPowerSource(accessory)) {
    const fragment = powerSourceFragment(device.getComponent('battery')?.getValue('level'));
    if (fragment) void platform.matter.updateAccessoryState(accessory.UUID, 'powerSource', fragment);
  }
}

/** Subscribes to component updates and forwards them to the Matter accessory state. */
export function attachComponentUpdates(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  const lastEnergyPush = new Map<string, number>();

  for (const { partId, component, kind, meter } of accessoryParts(device, accessory)) {
    const forward = (source: ShellyComponent, propertyMap: (typeof PROPERTY_MAPS)[ComponentKind]) => {
      source.on('update', (_componentId: string, property: string, value: ShellyDataType) => {
        const entry = propertyMap.get(property);
        if (!entry || (entry.metered && !metering)) return;
        // Check the throttle window before converting so suppressed energy
        // updates cost nothing; stamp only after a successful conversion.
        const throttleKey = entry.throttled ? `${source.id}:${property}` : undefined;
        if (throttleKey !== undefined && Date.now() - (lastEnergyPush.get(throttleKey) ?? 0) < ENERGY_PUSH_MIN_INTERVAL_MS) return;
        const fragment = entry.convert(value);
        if (fragment === undefined) return;
        if (throttleKey !== undefined) lastEnergyPush.set(throttleKey, Date.now());
        void platform.matter.updateAccessoryState(accessory.UUID, entry.cluster, fragment, partId);
      });
    };
    forward(component, PROPERTY_MAPS[kind]);
    // A merged meter's updates land on the actuator's endpoint.
    if (meter) forward(meter, PROPERTY_MAPS.meter);
  }

  // Battery updates target the composed parent's PowerSource cluster.
  if (accessoryPowerSource(accessory)) {
    device.getComponent('battery')?.on('update', (_componentId: string, property: string, value: ShellyDataType) => {
      if (property !== 'level') return;
      const fragment = powerSourceFragment(value);
      if (fragment) void platform.matter.updateAccessoryState(accessory.UUID, 'powerSource', fragment);
    });
  }
}
