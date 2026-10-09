import type { PlatformConfig } from 'homebridge';

export const ACCESSORY_TYPES = ['light', 'outlet', 'switch'] as const;
export type AccessoryType = (typeof ACCESSORY_TYPES)[number];

/**
 * The component kinds this plugin maps to Matter. Switch components carry a
 * configurable accessory type (light/outlet/switch); every other kind has a
 * fixed Matter device type. Shared with the settings UI so its table and the
 * platform classify channels identically.
 */
export const SENSOR_KINDS = ['temperature', 'humidity', 'flood', 'contact', 'illuminance', 'vibration', 'motion', 'smoke', 'gas'] as const;
/** Read-only sensor kinds: no type choice, no handlers, never split (one physical unit). */
export type SensorKind = (typeof SENSOR_KINDS)[number];
export const COMPONENT_KINDS = ['switch', 'cover', 'dimmer', 'color', ...SENSOR_KINDS, 'meter', 'button', 'thermostat'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** How a gas detector's alarm is exposed - Matter has no gas detector type, so the user picks the alarm it appears as. */
export const GAS_ALARM_MODES = ['smoke', 'co'] as const;
export type GasAlarmMode = (typeof GAS_ALARM_MODES)[number];
export const isSensorKind = (kind: string): kind is SensorKind => (SENSOR_KINDS as readonly string[]).includes(kind);

/** Kinds whose channels may split into separate accessories (sensors and meters never do). */
export const isSplittableKind = (kind: string): boolean => kind === 'switch' || kind === 'cover' || kind === 'dimmer' || kind === 'color';

/** Shelly Plus Add-on components (probes, inputs) are numbered from 100. */
export const ADDON_INDEX_MIN = 100;

/** Three-phase meter channels by index: the total (em:0), then the phases. */
export const METER_PHASES = ['Total', 'Phase A', 'Phase B', 'Phase C'];

/** devices.json kind marker of the triphase total channel (a meter that is hidden by default). */
export const METER_TOTAL_KIND = 'meter-total';

/**
 * Per-channel settings of a multi-channel device. An entry addresses a relay,
 * cover, dimmer or sensor by `channel` and a meter by `meter` (both 0-based
 * component indices, as on the device): on EM-style devices the relay and
 * the first clamp are both index 0.
 */
export interface ShellyChannelConfig {
  channel?: number;
  meter?: number;
  /** Only used in the Home app when the device's channels are split into separate accessories. */
  name?: string;
  accessoryType?: AccessoryType;
  hidden?: boolean;
}

/**
 * One entry in the `devices` config array - one physical device.
 * Entries with only `host` add a device that mDNS cannot find; the entry then
 * applies to the device created from that host. For multi-channel devices the
 * top-level `accessoryType` is the fallback for channels without their own.
 */
export interface ShellyDeviceConfig {
  device?: string;
  host?: string;
  name?: string;
  accessoryType?: AccessoryType;
  hidden?: boolean;
  powerMetering?: boolean;
  /**
   * Door/Window sensors: expose the vibration (impact) detection as a motion
   * sensor. Matter has no vibration sensor type, so this is a re-mapping the
   * user opts into; OFF by default.
   */
  vibrationAsMotion?: boolean;
  /** Gas detectors: expose the alarm as a smoke or CO alarm ('off' or absent = not exposed). */
  gasAlarm?: GasAlarmMode | 'off';
  /**
   * EM devices with a relay: show the first clamp's readings on the relay's
   * accessory (a working switch with wattage on its tile) instead of as a
   * meter channel of its own. Right when that clamp measures the circuit the
   * relay switches; OFF by default.
   */
  clampOnRelay?: boolean;
  /**
   * Multi-channel devices only: expose each channel as its own accessory
   * (assignable to its own room). ON by default - set false to expose the
   * device as one grouped accessory. Toggling re-creates the accessories.
   */
  splitChannels?: boolean;
  channels?: ShellyChannelConfig[];
}

export function deviceConfigs(config: PlatformConfig): ShellyDeviceConfig[] {
  const list = config.devices;
  return Array.isArray(list) ? (list.filter((entry) => entry !== null && typeof entry === 'object') as ShellyDeviceConfig[]) : [];
}

/** Entry for a device id; falls back to a host-only entry. */
export function configForDevice(config: PlatformConfig, deviceId: string, host?: string): ShellyDeviceConfig | undefined {
  const entries = deviceConfigs(config);
  return entries.find((entry) => entry.device === deviceId) ?? (host !== undefined ? entries.find((entry) => entry.device === undefined && entry.host === host) : undefined);
}

function findChannel(entry: ShellyDeviceConfig | undefined, match: (c: ShellyChannelConfig) => boolean): ShellyChannelConfig | undefined {
  if (!Array.isArray(entry?.channels)) return undefined;
  return entry.channels.find((c) => c !== null && typeof c === 'object' && match(c));
}

export const channelConfig = (entry: ShellyDeviceConfig | undefined, channel: number): ShellyChannelConfig | undefined =>
  findChannel(entry, (c) => c.channel === channel);

/**
 * A meter's entry. Meters were addressed by `channel` before `meter` existed;
 * such an entry still applies unless one of the device's actuators (relay,
 * cover, dimmer - hidden ones included) has that index and owns it.
 */
export const meterConfig = (entry: ShellyDeviceConfig | undefined, meter: number, actuatorIndexes: readonly number[]): ShellyChannelConfig | undefined =>
  findChannel(entry, (c) => c.meter === meter) ?? (actuatorIndexes.includes(meter) ? undefined : channelConfig(entry, meter));

/**
 * Whether a channel is hidden: its own setting, else the kind's default. The
 * triphase total hides by default - the phases already sum to it, and exposing
 * both would double-count energy in Apple Home's whole-home total.
 */
export const channelHidden = (config: ShellyChannelConfig | undefined, hiddenByDefault = false): boolean => config?.hidden ?? hiddenByDefault;

/** The types a meter channel can be shown as: an electrical sensor (the default) or a virtual outlet whose tile shows the wattage. */
export const METER_TYPES = ['meter', 'outlet'] as const;
export type MeterType = (typeof METER_TYPES)[number];

/**
 * How a meter channel is shown. Only an EXPLICIT `outlet` counts - the
 * channel's own setting, or the device's when the device has no relay
 * channels (then the device setting cannot mean a relay). Never the id-based
 * default: `shellyem*` ids default to outlet for their relay.
 */
export function resolveMeterType(entry: ShellyDeviceConfig | undefined, meter: number, actuatorIndexes: readonly number[]): MeterType {
  const chosen = meterConfig(entry, meter, actuatorIndexes)?.accessoryType ?? (actuatorIndexes.length > 0 ? undefined : entry?.accessoryType);
  return chosen === 'outlet' ? 'outlet' : 'meter';
}

/** The device (entry) is hidden from Matter altogether. */
export const deviceHidden = (entry: ShellyDeviceConfig | undefined): boolean => entry?.hidden === true;

/** Power metering is on unless the entry switches it off. */
export const powerMeteringEnabled = (entry: ShellyDeviceConfig | undefined): boolean => entry?.powerMetering !== false;

/** The alarm a gas detector is exposed as, or undefined when the entry has not opted in. */
export const gasAlarmMode = (entry: ShellyDeviceConfig | undefined): GasAlarmMode | undefined => GAS_ALARM_MODES.find((mode) => mode === entry?.gasAlarm);

/** The first EM clamp rides on the relay only when the entry opts in. */
export const clampOnRelayEnabled = (entry: ShellyDeviceConfig | undefined): boolean => entry?.clampOnRelay === true;

/** Vibration exposed as a motion sensor only when the entry opts in. */
export const vibrationAsMotionEnabled = (entry: ShellyDeviceConfig | undefined): boolean => entry?.vibrationAsMotion === true;

/**
 * Default presentation: plugs and power strips are outlets, wired relay
 * devices usually drive lights. Plug-in devices (Plug S, Plug US/UK/IT, Gen 1
 * Plug...) all carry 'plug' in the device id, power strips 'pstrip'.
 */
export const defaultAccessoryType = (deviceId: string): AccessoryType => (deviceId.includes('plug') || deviceId.includes('pstrip') || deviceId.startsWith('shellyem') ? 'outlet' : 'light');

/**
 * Splitting multi-channel devices into separate accessories is the DEFAULT
 * (multi-channel relays usually switch unrelated loads in different rooms);
 * `splitChannels: false` records the grouped choice. Single source for the
 * platform, the reconciliation, and the settings UI server.
 */
export const splitChannelsEnabled = (entry: ShellyDeviceConfig | undefined): boolean => entry?.splitChannels !== false;

/**
 * Channel setting wins over the device setting, which wins over the kind-based
 * default. The single source of these rules - the platform resolves accessory
 * types through it, and the settings UI server does too, so the two can never
 * disagree. Takes the device's resolved entry (see configForDevice).
 */
export function resolveAccessoryType(entry: ShellyDeviceConfig | undefined, deviceId: string, channel?: number): AccessoryType {
  const channelEntry = channel === undefined ? undefined : channelConfig(entry, channel);
  if (channelEntry?.accessoryType && ACCESSORY_TYPES.includes(channelEntry.accessoryType)) return channelEntry.accessoryType;
  if (entry?.accessoryType && ACCESSORY_TYPES.includes(entry.accessoryType)) return entry.accessoryType;
  return defaultAccessoryType(deviceId);
}
