import type { MatterAccessory } from 'homebridge';

// Not re-exported from 'homebridge', so derive the part type from MatterAccessory.
type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];

import { ACCESSORY_TYPES, type AccessoryType, channelConfig, channelHidden, type ComponentKind, configForDevice, GAS_ALARM_MODES, type GasAlarmMode, gasAlarmMode, isSensorKind, isSplittableKind, powerMeteringEnabled, resolveAccessoryType, splitChannelsEnabled, vibrationAsMotionEnabled } from './deviceConfig.js';
import type { ShellyMatterPlatform } from './platform.js';
import { isCoverComponent, isLightComponent, isSwitchComponent, type ShellyComponent } from './shelly/shellyComponent.js';
import type { ShellyDevice } from './shelly/shellyDevice.js';
import type { ShellyData, ShellyDataType } from './shelly/shellyTypes.js';
import { isValidNumber, isValidObject } from './shelly/utils/index.js';

export type { ComponentKind } from './deviceConfig.js';

/** A part's identity token: the accessory type for switches, the kind otherwise. */
type PartToken = AccessoryType | 'cover' | 'dimmer' | 'temperature' | 'humidity' | 'flood' | 'contact' | 'illuminance' | 'vibration' | GasAlarmMode | 'meter';

/** Part name suffix per sensor kind (identity-bearing: cached display names must keep matching). */
const SENSOR_PART_LABEL: Record<string, string> = { temperature: 'Temperature', humidity: 'Humidity', flood: 'Water Leak', contact: 'Contact', illuminance: 'Light', vibration: 'Vibration', gas: 'Gas' };

/** The triphase total channel (em:0 only exists on three-phase meters): hidden by default, the phases already sum to it. */
const isTriphaseTotal = (componentId: string): boolean => componentId === 'em:0';

// Matter electrical measurement attributes use milli-units: mV, mA, mW, mWh.
const milli = (value: number): number => Math.round(value * 1000);

// Energy updates are pushed to controllers unthrottled (CumulativeEnergyMeasured
// events), so Homebridge documents a 30-60s cadence. Shelly notifies more often.
const ENERGY_PUSH_MIN_INTERVAL_MS = 30_000;
/** How long a momentary event (an impact on a Door/Window sensor) stays "on" in Matter before the plugin clears it. */
const VIBRATION_HOLD_MS = 30_000;

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
/**
 * WindowCovering ConfigStatus for a position-aware lift: Homebridge composes
 * the cluster's Lift feature from the position attributes but adds
 * PositionAwareLift ONLY when `configStatus.liftPositionAware` is declared -
 * without it matter.js rejects the position attributes ("LF & PA_LF") and
 * the registration fails (#11).
 */
const LIFT_CONFIG_STATUS = { operational: true, onlineReserved: false, liftMovementReversed: false, liftPositionAware: true, tiltPositionAware: false, liftEncoderControlled: false, tiltEncoderControlled: false };

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
  /** The source component is passed so a row can pick unit math per component family (Gen 1 meter vs emeter). */
  convert: (value: ShellyDataType, component?: ShellyComponent) => ClusterState | undefined;
  kinds?: ComponentKind[];
  /** Only forwarded when the device's power metering is enabled. */
  metered?: boolean;
  throttled?: boolean;
  /** A pulse, not a state: never part of a snapshot, and cleared again VIBRATION_HOLD_MS after it fires (the sensor sleeps right after reporting it, so no "0" follows). */
  momentary?: boolean;
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
  // Door/Window: the protocol layer keeps the magnet state on the 'sensor'
  // component as contact_open; Matter's ContactSensor is true when CLOSED.
  { property: 'contact_open', cluster: 'booleanState', convert: (v) => (typeof v === 'boolean' ? { stateValue: !v } : undefined), kinds: ['contact'] },
  // Matter encodes illuminance as 10000 * log10(lux) + 1 (0 = too dark to measure).
  { property: 'value', cluster: 'illuminanceMeasurement', convert: (v) => (isValidNumber(v, 0) ? { measuredValue: v <= 0 ? 0 : Math.min(0xfffe, Math.round(10000 * Math.log10(v) + 1)) } : undefined), kinds: ['illuminance'] },
  // Matter has no vibration sensor: an impact is exposed as an occupancy (motion)
  // sensor, which controllers can alert and automate on (#10). Gen 1 reports it
  // as a boolean (HTTP status) or 0/1 (CoIoT).
  { property: 'vibration', cluster: 'occupancySensing', convert: (v) => (typeof v === 'boolean' || typeof v === 'number' ? { occupancy: { occupied: v === true || v === 1 } } : undefined), kinds: ['vibration'], momentary: true },
  // Meter (PowerMeter) components: em1/em/pm1 report plain W/V/A/Wh; the
  // vendored layer folds the em1data/emdata energy counters into the same
  // component. powerFactor is hundredths of a percent, frequency is mHz.
  { property: 'act_power', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v) ? { activePower: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'aprt_power', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { apparentPower: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'freq', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, 0) ? { frequency: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'pf', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v, -1, 1) ? { powerFactor: Math.round(v * 10000) } : undefined), kinds: ['meter'], metered: true },
  { property: 'total_act_energy', cluster: 'electricalEnergyMeasurement', convert: (v) => (isValidNumber(v, 0) ? { cumulativeEnergyImported: { energy: milli(v) } } : undefined), kinds: ['meter'], metered: true, throttled: true },
  { property: 'total_act_ret_energy', cluster: 'electricalEnergyMeasurement', convert: (v) => (isValidNumber(v, 0) ? { cumulativeEnergyExported: { energy: milli(v) } } : undefined), kinds: ['meter'], metered: true, throttled: true },
  // Gen 1 meters: relay/dimmer/plug `meters` (meter:N) report energy in
  // WATT-MINUTES, EM/3EM `emeters` (emeter:N) in Wh - both under `total`.
  // (Gen 1 relay/dimmer totals also reset when the device reboots - device
  // behavior, not ours.)
  { property: 'power', cluster: 'electricalPowerMeasurement', convert: (v) => (isValidNumber(v) ? { activePower: milli(v) } : undefined), kinds: ['meter'], metered: true },
  { property: 'total', cluster: 'electricalEnergyMeasurement', convert: (v, c) => (isValidNumber(v, 0) ? { cumulativeEnergyImported: { energy: c?.id.startsWith('emeter:') ? milli(v) : Math.round((v * 1000) / 60) } } : undefined), kinds: ['meter'], metered: true, throttled: true },
  { property: 'total_returned', cluster: 'electricalEnergyMeasurement', convert: (v) => (isValidNumber(v, 0) ? { cumulativeEnergyExported: { energy: milli(v) } } : undefined), kinds: ['meter'], metered: true, throttled: true },
];

/** Per-kind property lookup, so a kind only ever sees its own rows. */
const PROPERTY_MAPS: Record<ComponentKind, Map<string, (typeof PROPERTY_MAP)[number]>> = {
  switch: new Map(),
  cover: new Map(),
  dimmer: new Map(),
  temperature: new Map(),
  humidity: new Map(),
  flood: new Map(),
  contact: new Map(),
  illuminance: new Map(),
  vibration: new Map(),
  gas: new Map(), // rows live in GAS_PROPERTY_MAPS, keyed by the chosen alarm
  meter: new Map(),
};
for (const entry of PROPERTY_MAP) {
  for (const kind of entry.kinds ?? (Object.keys(PROPERTY_MAPS) as ComponentKind[])) {
    PROPERTY_MAPS[kind].set(entry.property, entry);
  }
}

// Gas detectors: Matter has no gas detector type, so the alarm is exposed as
// the user's choice of smoke or CO alarm (the part token). Shelly reports
// none/mild/heavy/test; Matter's AlarmState is Normal/Warning/Critical and
// ExpressedState names the alarm (1 smoke, 2 CO, 4 testing).
const gasLevel = (v: ShellyDataType): number => (v === 'heavy' ? 2 : v === 'mild' ? 1 : 0);
const gasRows = (mode: GasAlarmMode): (typeof PROPERTY_MAP)[number][] => [
  {
    property: 'alarm_state',
    cluster: 'smokeCoAlarm',
    convert: (v) => (typeof v === 'string' ? { [mode === 'co' ? 'coState' : 'smokeState']: gasLevel(v), expressedState: v === 'test' ? 4 : gasLevel(v) ? (mode === 'co' ? 2 : 1) : 0, testInProgress: v === 'test' } : undefined),
  },
  { property: 'sensor_state', cluster: 'smokeCoAlarm', convert: (v) => (typeof v === 'string' ? { hardwareFaultAlert: v === 'fault' } : undefined) },
];
const GAS_PROPERTY_MAPS: Record<GasAlarmMode, Map<string, (typeof PROPERTY_MAP)[number]>> = Object.fromEntries(
  GAS_ALARM_MODES.map((mode) => [mode, new Map(gasRows(mode).map((entry) => [entry.property, entry]))]),
) as Record<GasAlarmMode, Map<string, (typeof PROPERTY_MAP)[number]>>;
const isGasMode = (token: PartToken | undefined): token is GasAlarmMode => (GAS_ALARM_MODES as readonly string[]).includes(token ?? '');
/** The property rows for a part: by kind, except gas detectors whose rows follow the chosen alarm (token). */
const propertyMapFor = (kind: ComponentKind, token?: PartToken): Map<string, (typeof PROPERTY_MAP)[number]> => (kind === 'gas' && isGasMode(token) ? GAS_PROPERTY_MAPS[token] : PROPERTY_MAPS[kind]);

/**
 * Part ids must avoid ':' and embed the identity token: a type change then
 * rotates the endpoint identity (id, uniqueId, endpoint number), so
 * controllers see a clean remove+add instead of a half-updated device -
 * Apple Home leaves accessories in an uneditable state when a device
 * reappears with the same uniqueId but a different device type.
 */
const partIdFor = (componentId: string, token: PartToken): string => `${componentId.replace(':', '-')}-${token}`;

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

/** Applies a component's current property values (per its kind's map) onto a cluster snapshot. */
function applySnapshot(clusters: Record<string, ClusterState>, component: ShellyComponent, kind: ComponentKind, metering: boolean, token?: PartToken): Record<string, ClusterState> {
  for (const entry of propertyMapFor(kind, token).values()) {
    if ((entry.metered && !metering) || entry.momentary || !component.hasProperty(entry.property)) continue;
    const fragment = entry.convert(component.getValue(entry.property), component);
    if (fragment === undefined) continue;
    Object.assign((clusters[entry.cluster] ??= {}), fragment);
  }
  return clusters;
}

/** Initial electrical cluster state contributed by a merged meter component. */
const meterClustersFor = (meter: ShellyComponent, metering: boolean): Record<string, ClusterState> => applySnapshot({}, meter, 'meter', metering);

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

interface MappedComponent {
  component: ShellyComponent;
  kind: ComponentKind;
  /** A same-index PowerMeter component whose measurements merge onto this actuator's endpoint. */
  meter?: ShellyComponent;
  /** Triphase total channel (em:0): hidden by default, since the phases already sum to it. */
  total?: boolean;
}

/** The components this plugin can expose, in device order. */
export function mappedComponents(device: ShellyDevice): MappedComponent[] {
  const mapped: MappedComponent[] = [];
  for (const [, component] of device) {
    // Gen 1 dual-mode devices (2.5, Shelly 2) expose BOTH relay and roller
    // components regardless of the configured mode - the vendored layer adds
    // them unconditionally. Map only the active profile's side: the inactive
    // one is a phantom that in Apple Home even collides with the real
    // accessory's name and serial (record fights, rooms shuffle).
    if (isSwitchComponent(component)) {
      if (device.profile !== 'cover') mapped.push({ component, kind: 'switch' });
    } else if (isCoverComponent(component)) {
      if (device.profile !== 'switch') mapped.push({ component, kind: 'cover' });
    }
    // Light components without brightness (and Rgb/Rgbw/Cct color channels)
    // are not mapped yet - see the README support matrix.
    else if (isLightComponent(component) && component.name === 'Light' && component.hasProperty('brightness')) mapped.push({ component, kind: 'dimmer' });
  }
  // PowerMeter components (em1/em/pm1, with the emdata counters folded in by
  // the protocol layer): a meter with a same-index actuator merges its
  // measurements onto that endpoint (the shape Apple Home fully supports -
  // live tile wattage on an outlet); meters without one become their own
  // ElectricalSensor part.
  for (const [, component] of device) {
    if (component.name !== 'PowerMeter') continue;
    // Gen 1 relays without metering still report a dummy meter (Shelly 1:
    // {power: 0, is_valid: true}); real Gen 1 meters carry a 'total' counter.
    if (component.id.startsWith('meter:') && !component.hasProperty('total')) continue;
    const actuator = mapped.find((m) => isSplittableKind(m.kind) && m.component.index === component.index && !m.meter);
    if (actuator) actuator.meter = component;
    else mapped.push({ component, kind: 'meter', ...(isTriphaseTotal(component.id) ? { total: true } : {}) });
  }
  // Environment sensors map only on sensor PRODUCTS (H&T, Flood, ...).
  // Relays and meters expose their INTERNAL device temperature under the
  // same component names - mapping those would sprout unwanted sensor
  // parts (and rotate identities). A device with meters is never empty here.
  if (mapped.length === 0) {
    for (const [, component] of device) {
      if (component.name === 'Temperature') mapped.push({ component, kind: 'temperature' });
      else if (component.name === 'Humidity') mapped.push({ component, kind: 'humidity' });
      else if (component.name === 'Flood') mapped.push({ component, kind: 'flood' });
      else if (component.name === 'Sensor' && component.hasProperty('contact_open')) mapped.push({ component, kind: 'contact' });
      else if (component.name === 'Lux') mapped.push({ component, kind: 'illuminance' });
      else if (component.name === 'Vibration') mapped.push({ component, kind: 'vibration' });
      else if (component.name === 'Gas') mapped.push({ component, kind: 'gas' });
    }
  }
  return mapped;
}

function meteringEnabled(platform: ShellyMatterPlatform, device: ShellyDevice): boolean {
  return powerMeteringEnabled(configForDevice(platform.config, device.id, platform.configHost(device)));
}

const DEVICE_TYPE_BY_TOKEN: Record<PartToken, keyof ShellyMatterPlatform['matter']['deviceTypes']> = {
  temperature: 'TemperatureSensor',
  humidity: 'HumiditySensor',
  flood: 'LeakSensor',
  contact: 'ContactSensor',
  illuminance: 'LightSensor',
  vibration: 'MotionSensor',
  smoke: 'SmokeSensor',
  co: 'SmokeSensor',
  meter: 'ElectricalSensor',
  cover: 'WindowCovering',
  dimmer: 'DimmableLight',
  switch: 'OnOffSwitch',
  light: 'OnOffLight',
  outlet: 'OnOffOutlet',
};
const matterDeviceTypeFor = (platform: ShellyMatterPlatform, token: PartToken) => platform.matter.deviceTypes[DEVICE_TYPE_BY_TOKEN[token]];

/** Initial cluster state for one component, with electrical clusters when the component meters. */
/**
 * The primary cluster per read-only kind - it must always exist (it is the
 * registration-verify probe and carries the mandatory attributes).
 */
const PRIMARY_CLUSTER: Record<string, [cluster: string, attributes: ClusterState]> = {
  temperature: ['temperatureMeasurement', { measuredValue: null }],
  humidity: ['relativeHumidityMeasurement', { measuredValue: null }],
  flood: ['booleanState', { stateValue: false }],
  contact: ['booleanState', { stateValue: true }],
  illuminance: ['illuminanceMeasurement', { measuredValue: null }],
  vibration: ['occupancySensing', { occupancy: { occupied: false } }],
  meter: ['electricalPowerMeasurement', { activePower: 0 }],
};

/** A gas detector's primary cluster: the chosen alarm feature at rest (Homebridge composes the feature from the declared state attribute). */
const gasPrimaryClusters = (mode: GasAlarmMode): Record<string, ClusterState> => ({ smokeCoAlarm: { [mode === 'co' ? 'coState' : 'smokeState']: 0, expressedState: 0, testInProgress: false } });

function clustersFor(component: ShellyComponent, kind: ComponentKind, metering: boolean, token?: PartToken): Record<string, ClusterState> {
  // Seed the primary cluster and let the map's own rows overwrite when the device reports.
  const primary = PRIMARY_CLUSTER[kind];
  const clusters: Record<string, ClusterState> = kind === 'gas'
    ? gasPrimaryClusters(isGasMode(token) ? token : 'smoke')
    : primary
      ? { [primary[0]]: { ...primary[1] } }
      : kind === 'cover'
        ? { windowCovering: { configStatus: LIFT_CONFIG_STATUS, currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0, operationalStatus: OPERATIONAL_STOPPED } }
        : { onOff: { onOff: false } };
  if (kind === 'dimmer') clusters.levelControl = { currentLevel: 254 };
  applySnapshot(clusters, component, kind, metering, token);
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
const kindOfToken = (token: PartToken): ComponentKind => ((ACCESSORY_TYPES as readonly string[]).includes(token) ? 'switch' : isGasMode(token) ? 'gas' : (token as ComponentKind));

/**
 * A component as the composition engine sees it - built from a live device
 * (buildShellyAccessories) or from a cached shell (expectedShellsFromCache),
 * so both paths compose through the SAME rules and cannot drift.
 */
interface Composable {
  componentId: string;
  index: number;
  kind: ComponentKind;
  /** Meter component merged onto this part's endpoint (same-index actuator + meter). */
  meterId?: string;
  /** The part's initial cluster state for its resolved token, metering already applied. */
  clustersFor: (token: PartToken) => Record<string, ClusterState>;
}

interface TypedComposable extends Composable {
  token: PartToken;
}

/** The identification fields every accessory of a device shares. */
type AccessoryTemplate = Pick<MatterAccessory, 'serialNumber' | 'manufacturer' | 'model' | 'firmwareRevision'>;

/** One composed accessory (BridgedNode parent + one part per given component); parts are named after the accessory unless told otherwise. */
function composeOne(
  platform: ShellyMatterPlatform,
  base: Pick<ShellyAccessoryContext, 'deviceId' | 'deviceName' | 'generation'>,
  typed: TypedComposable[],
  seed: string,
  displayName: string,
  template: AccessoryTemplate,
  parentClusters?: Record<string, ClusterState>,
  partNameFor: (component: Composable) => string = () => displayName,
): MatterAccessory {
  const { deviceId } = base;
  const uuid = platform.matter.uuid.generate(seed);
  const partTypes: Record<string, PartToken> = {};
  const partComponents: Record<string, string> = {};
  const partMeters: Record<string, string> = {};
  const parts: MatterAccessoryPart[] = typed.map((component) => {
    const partId = partIdFor(component.componentId, component.token);
    partTypes[partId] = component.token;
    partComponents[partId] = component.componentId;
    if (component.meterId !== undefined) partMeters[partId] = component.meterId;
    return {
      id: partId,
      displayName: partNameFor(component),
      deviceType: matterDeviceTypeFor(platform, component.token),
      clusters: component.clustersFor(component.token),
      handlers: handlersFor(platform, uuid, deviceId, component.componentId, partId, component.kind),
    };
  });
  const context: ShellyAccessoryContext = { ...base, partTypes, partComponents, ...(Object.keys(partMeters).length ? { partMeters } : {}) };
  return {
    UUID: uuid,
    displayName,
    ...template,
    context,
    deviceType: platform.matter.deviceTypes.BridgedNode,
    ...(parentClusters ? { clusters: parentClusters } : {}),
    parts,
  };
}

/**
 * THE composition engine: visibility (hidden channels, metering off, the
 * triphase total's inverted default), canonical part order, names, tokens
 * and identity seeds - for live devices and cache rebuilds alike.
 *
 * EVERY accessory is a BridgedNode parent with parts - matching how
 * matterbridge exposes devices (single-channel included); Apple hubs are
 * only known to behave with this composed shape. By default a device is ONE
 * accessory with a part per visible channel; with `splitChannels`, each
 * channel becomes its own accessory (Apple Home assigns rooms per accessory).
 *
 * Identity embeds the effective composition (visible channels and their
 * types) so ANY composition change - retyping a channel, hiding one,
 * toggling splitChannels - rotates the accessory identity, parent included.
 * Controllers then see a clean remove+add; a parent that keeps its identity
 * while its children change becomes an uneditable "Not Supported" husk in
 * Apple Home.
 */
function composeAccessories(
  platform: ShellyMatterPlatform,
  deviceId: string,
  host: string | undefined,
  fallbackName: string,
  generation: number,
  all: Composable[],
  template: AccessoryTemplate,
  parentClusters?: Record<string, ClusterState>,
): MatterAccessory[] {
  const entry = configForDevice(platform.config, deviceId, host);
  const metering = powerMeteringEnabled(entry);
  const vibration = vibrationAsMotionEnabled(entry);
  const gas = gasAlarmMode(entry);
  const rank = (component: Composable): number => (isSplittableKind(component.kind) ? 0 : 1);
  const visible = all
    .filter(({ componentId, index, kind }) =>
      (kind !== 'meter' || metering) && (kind !== 'vibration' || vibration) && (kind !== 'gas' || gas !== undefined) && !channelHidden(entry, index, isTriphaseTotal(componentId)))
    // Canonical order - actuators first, then measurement parts, each by
    // index (stable sort) - so live builds and cache rebuilds seed the
    // same identity whatever order the components arrived in.
    .sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  if (visible.length === 0) return [];

  const displayName = entry?.name ?? fallbackName;
  // Each component's token is resolved exactly once and feeds both the
  // identity seed and the part construction, so the two cannot drift.
  const tokenFor = (component: Composable): PartToken => {
    if (component.kind === 'switch') return resolveAccessoryType(entry, deviceId, component.index);
    if (component.kind === 'gas') return gas ?? 'smoke'; // gas parts are only visible with a chosen alarm
    return component.kind;
  };
  const typed: TypedComposable[] = visible.map((component) => ({ ...component, token: tokenFor(component) }));
  // Multi-channel names get an index suffix (tiles are renamed in the Home app);
  // sensor and meter parts get their measurement label instead.
  const actuatorCount = typed.filter(({ kind }) => isSplittableKind(kind)).length;
  const channelName = ({ componentId, index, kind }: Composable): string => {
    if (kind === 'meter') return `${displayName} ${meterPartLabel(componentId, index)}`;
    const label = SENSOR_PART_LABEL[kind];
    if (label !== undefined) return `${displayName} ${label}`;
    return actuatorCount <= 1 ? displayName : `${displayName} ${index + 1}`;
  };

  // Sensor and meter parts never split into separate accessories (one
  // physical unit / measurement channels of one meter).
  const base = { deviceId, deviceName: displayName, generation };
  if (splitChannelsEnabled(entry) && typed.length > 1 && typed.every(({ kind }) => isSplittableKind(kind))) {
    return typed.map((one) => {
      // Split accessories can carry a per-channel name (grouped parts cannot
      // reach the Home app with one, so channel names only apply here).
      const name = channelConfig(entry, one.index)?.name ?? channelName(one);
      return composeOne(platform, base, [one], `${deviceId}|split|${one.index}:${one.token}${generationSuffix(generation)}`, name, template);
    });
  }
  const seed = `${deviceId}|bridge|${typed.map(({ index, token }) => `${index}:${token}`).join(',')}${generationSuffix(generation)}`;
  return [composeOne(platform, base, typed, seed, displayName, template, parentClusters, channelName)];
}

/** Builds the MatterAccessories for a live Shelly device (empty if it has no visible supported components). */
export function buildShellyAccessories(platform: ShellyMatterPlatform, device: ShellyDevice, generation = 0): MatterAccessory[] {
  const metering = meteringEnabled(platform, device);
  const all: Composable[] = mappedComponents(device).map(({ component, kind, meter }) => ({
    componentId: component.id,
    index: component.index,
    kind,
    meterId: meter?.id,
    // A merged meter contributes its electrical clusters to the actuator's
    // own endpoint - the shape controllers (Apple Home included) support.
    clustersFor: (token) => ({ ...clustersFor(component, kind, metering, token), ...(meter ? meterClustersFor(meter, metering) : {}) }),
  }));
  // Battery state (H&T, Flood, ...) lives on the composed parent's PowerSource
  // cluster - the core composes the Battery feature from these attributes.
  const battery = device.getComponent('battery');
  const parentClusters = battery && all.some(({ kind }) => isSensorKind(kind)) ? { powerSource: powerSourceClusterFor(battery) } : undefined;
  const template: AccessoryTemplate = { serialNumber: device.mac, manufacturer: 'Shelly', model: device.model, firmwareRevision: device.firmware };
  return composeAccessories(platform, device.id, platform.configHost(device), device.name, generation, all, template, parentClusters);
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
  sensor: 'contact',
  lux: 'illuminance',
  vibration: 'vibration',
  gas: 'gas',
  em1: 'meter',
  em: 'meter',
  pm1: 'meter',
  meter: 'meter',
  emeter: 'meter',
};

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

/** The highest rotation generation recorded in a device's cached accessories. */
export const cachedGenerationOf = (cachedList: MatterAccessory[]): number =>
  Math.max(0, ...cachedList.map((cached) => (cached.context as Partial<ShellyAccessoryContext> | undefined)?.generation ?? 0));

/**
 * Rebuilds a device's EXPECTED accessories from its cached accessories plus
 * the current config - through the same composition engine as live builds,
 * with components reconstructed from the cached contexts and cluster
 * snapshots carried over. This lets the platform apply composition changes
 * (splitChannels, type changes, hidden channels, metering off) at startup,
 * BEFORE the Matter node goes online: paired controllers then only ever see
 * the final structure. Rotating live on a commissioned bridge desyncs Apple
 * Home (the bridge record is rebuilt, devices vanish until the hub reboots).
 *
 * `minGeneration` is the generation persisted in devices.json - a floor, so
 * a rotation never lands on an identity used before the cache was lost.
 * Returns undefined for foreign/corrupt cache entries.
 */
export function expectedShellsFromCache(platform: ShellyMatterPlatform, deviceId: string, cachedList: MatterAccessory[], host?: string, minGeneration = 0): { shells: MatterAccessory[]; generation: number } | undefined {
  const metering = powerMeteringEnabled(configForDevice(platform.config, deviceId, host));

  const components = new Map<string, Composable>();
  let template: MatterAccessory | undefined;
  let cachedDeviceName: string | undefined;
  const cachedGeneration = cachedGenerationOf(cachedList);
  // Metering switched off since the cache was written strips clusters from
  // parts that keep their identity - a structural change, which must rotate
  // (here, pre-online) rather than reappear on a uniqueId controllers know.
  let stripped = false;
  for (const cached of cachedList) {
    const context = cached.context as Partial<ShellyAccessoryContext> | undefined;
    if (!context?.partComponents || !context.partTypes) continue;
    template ??= cached;
    cachedDeviceName ??= context.deviceName;
    for (const part of cached.parts ?? []) {
      const componentId = context.partComponents[part.id];
      if (componentId === undefined || components.has(componentId)) continue;
      const match = componentId.match(/^(.+?):(\d+)$/) ?? componentId.match(/^([a-z_]+)$/i);
      const kind = match ? KIND_BY_COMPONENT_PREFIX[match[1].toLowerCase()] : undefined;
      if (!match || !kind) continue;
      const index = match[2] !== undefined ? Number(match[2]) : -1;
      if (!metering && ('electricalPowerMeasurement' in part.clusters || 'electricalEnergyMeasurement' in part.clusters)) stripped = true;
      // The carried snapshot keeps the registered shape; a gas alarm's shape
      // follows the chosen mode (token), so it is rebuilt from that instead.
      const carried = clustersForMetering(part.clusters, metering);
      components.set(componentId, { componentId, index, kind, meterId: context.partMeters?.[part.id], clustersFor: (token) => (kind === 'gas' && isGasMode(token) ? gasPrimaryClusters(token) : carried) });
    }
  }
  if (!template || components.size === 0) return undefined;

  const shell = template;
  const powerSource = accessoryPowerSource(shell);
  const buildAt = (generation: number): MatterAccessory[] =>
    composeAccessories(
      platform,
      deviceId,
      host,
      // Recorded device name, else a grouped accessory's own display name
      // (pre-deviceName caches are always grouped); the config name wins inside.
      cachedDeviceName ?? shell.displayName,
      generation,
      [...components.values()],
      { serialNumber: shell.serialNumber, manufacturer: shell.manufacturer, model: shell.model, firmwareRevision: shell.firmwareRevision },
      powerSource ? { powerSource } : undefined,
    );

  const atCachedGeneration = buildAt(cachedGeneration);
  if (atCachedGeneration.length === 0) return { shells: [], generation: cachedGeneration };
  const cachedUuids = new Set(cachedList.map((cached) => cached.UUID));
  const unchanged = !stripped && atCachedGeneration.length === cachedUuids.size && atCachedGeneration.every((expected) => cachedUuids.has(expected.UUID));
  // A composition change rebuilds one generation up so the rotation lands on
  // a NEVER previously used identity (a revert would otherwise resurrect
  // endpoints controllers just deleted); the persisted floor wins when higher.
  const target = Math.max(unchanged ? cachedGeneration : cachedGeneration + 1, minGeneration);
  if (target === cachedGeneration) return { shells: atCachedGeneration, generation: cachedGeneration };
  return { shells: buildAt(target), generation: target };
}

/** The comparable shape of an accessory: metadata (name, firmware) plus the structure (device types and cluster sets). */
function signatureOf(accessory: MatterAccessory) {
  const typeName = (deviceType: unknown): string => (deviceType as { name?: string })?.name ?? String(deviceType);
  return {
    name: accessory.displayName,
    firmware: accessory.firmwareRevision,
    clusters: Object.keys((accessory as { clusters?: Record<string, ClusterState> }).clusters ?? {}).sort(),
    parts: (accessory.parts ?? []).map((part) => ({
      id: part.id,
      name: part.displayName,
      type: typeName(part.deviceType),
      clusters: Object.keys(part.clusters).sort(),
    })),
  };
}

/**
 * Signatures to decide whether a live device matches its cached registration
 * (compared only in-memory within one process, never persisted):
 * - `signature`: everything, name and firmware included, so a rename or a
 *   Shelly OTA re-registers the accessory in place (same identity) and
 *   controllers see the new values;
 * - `structure`: device types and cluster sets only. A structural change on
 *   an identity a controller already knows must NOT re-register in place -
 *   Apple Home breaks the accessory's record when a known uniqueId reappears
 *   with a different structure ("unable to change settings", #8) - so the
 *   platform defers those to a pre-online rotation at the next startup.
 */
export function accessorySignatures(accessory: MatterAccessory): { signature: string; structure: string } {
  const full = signatureOf(accessory);
  return {
    signature: JSON.stringify(full),
    structure: JSON.stringify({ clusters: full.clusters, parts: full.parts.map(({ id, type, clusters }) => ({ id, type, clusters })) }),
  };
}

/**
 * The accessory's own parts resolved to live components. Driven by the
 * registered shape (context), not by re-deriving from config, so a split
 * accessory only ever touches its own channel.
 */
interface ResolvedPart {
  partId: string;
  component: ShellyComponent;
  kind: ComponentKind;
  token: PartToken;
  meter?: ShellyComponent;
  /** The clusters the registered part actually declares - updates for any other cluster would throw in matter.js. */
  declared: Set<string>;
}

function accessoryParts(device: ShellyDevice, accessory: MatterAccessory): ResolvedPart[] {
  const context = accessory.context as Partial<ShellyAccessoryContext> | undefined;
  const resolved: ResolvedPart[] = [];
  for (const part of accessory.parts ?? []) {
    const componentId = context?.partComponents?.[part.id];
    const component = componentId !== undefined ? device.getComponent(componentId) : undefined;
    if (!component) continue;
    const token = context?.partTypes?.[part.id];
    const meterId = context?.partMeters?.[part.id];
    const meter = meterId !== undefined ? device.getComponent(meterId) : undefined;
    const resolvedToken = (token ?? 'light') as PartToken;
    resolved.push({ partId: part.id, component, kind: kindOfToken(resolvedToken), token: resolvedToken, meter, declared: new Set(Object.keys(part.clusters)) });
  }
  return resolved;
}

/**
 * Pushes the device's current state into an already-registered accessory -
 * only into clusters the registered parts declare (a shell kept at its old
 * structure while a rotation is pending lacks the newer ones).
 */
export function pushCurrentState(platform: ShellyMatterPlatform, device: ShellyDevice, accessory: MatterAccessory): void {
  const metering = meteringEnabled(platform, device);
  for (const { partId, component, kind, token, meter, declared } of accessoryParts(device, accessory)) {
    const push = (clusters: Record<string, ClusterState>) => {
      for (const [cluster, attributes] of Object.entries(clusters)) {
        if (declared.has(cluster)) void platform.matter.updateAccessoryState(accessory.UUID, cluster, attributes, partId);
      }
    };
    push(clustersFor(component, kind, metering, token));
    if (meter) push(meterClustersFor(meter, metering));
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
  // A status notification updates several properties of one cluster in one
  // synchronous burst (apower/voltage/current): coalesce per (part, cluster)
  // and flush once, so it costs one matter.js transaction instead of three.
  const pending = new Map<string, { partId: string; cluster: string; state: ClusterState }>();
  const holdTimers = new Map<string, NodeJS.Timeout>();
  const flush = () => {
    for (const { partId, cluster, state } of pending.values()) void platform.matter.updateAccessoryState(accessory.UUID, cluster, state, partId);
    pending.clear();
  };
  const queue = (partId: string, cluster: string, fragment: ClusterState) => {
    const key = `${partId}|${cluster}`;
    const slot = pending.get(key);
    if (slot) {
      Object.assign(slot.state, fragment);
      return;
    }
    if (pending.size === 0) queueMicrotask(flush);
    pending.set(key, { partId, cluster, state: { ...fragment } });
  };

  for (const { partId, component, kind, token, meter, declared } of accessoryParts(device, accessory)) {
    const forward = (source: ShellyComponent, propertyMap: (typeof PROPERTY_MAPS)[ComponentKind]) => {
      source.on('update', (_componentId: string, property: string, value: ShellyDataType) => {
        const entry = propertyMap.get(property);
        if (!entry || (entry.metered && !metering) || !declared.has(entry.cluster)) return;
        // Check the throttle window before converting so suppressed energy
        // updates cost nothing; stamp only after a successful conversion.
        const throttleKey = entry.throttled ? `${source.id}:${property}` : undefined;
        if (throttleKey !== undefined && Date.now() - (lastEnergyPush.get(throttleKey) ?? 0) < ENERGY_PUSH_MIN_INTERVAL_MS) return;
        const fragment = entry.convert(value, source);
        if (fragment === undefined) return;
        if (throttleKey !== undefined) lastEnergyPush.set(throttleKey, Date.now());
        queue(partId, entry.cluster, fragment);
        if (entry.momentary) {
          // Re-arm the clear on every pulse; the "off" value is the converted
          // inactive reading so the clearing fragment has the same shape.
          const holdKey = `${partId}|${entry.property}`;
          clearTimeout(holdTimers.get(holdKey));
          const off = entry.convert(false, source);
          if (off !== undefined && JSON.stringify(off) !== JSON.stringify(fragment)) {
            holdTimers.set(holdKey, setTimeout(() => { holdTimers.delete(holdKey); queue(partId, entry.cluster, off); }, VIBRATION_HOLD_MS));
          }
        }
      });
    };
    forward(component, propertyMapFor(kind, token));
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
