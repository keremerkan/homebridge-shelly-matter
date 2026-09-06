import type { PlatformConfig } from 'homebridge';

export const ACCESSORY_TYPES = ['light', 'outlet', 'switch'] as const;
export type AccessoryType = (typeof ACCESSORY_TYPES)[number];

/**
 * The component kinds this plugin maps to Matter. Switch components carry a
 * configurable accessory type (light/outlet/switch); every other kind has a
 * fixed Matter device type. Shared with the settings UI so its table and the
 * platform classify channels identically.
 */
export type ComponentKind = 'switch' | 'cover' | 'dimmer' | 'temperature' | 'humidity' | 'flood' | 'contact' | 'illuminance' | 'vibration' | 'smoke' | 'gas' | 'meter';

/** Read-only sensor kinds: no type choice, no handlers, never split (one physical unit). */
export const SENSOR_KINDS = ['temperature', 'humidity', 'flood', 'contact', 'illuminance', 'vibration', 'smoke', 'gas'] as const;

/** How a gas detector's alarm is exposed - Matter has no gas detector type, so the user picks the alarm it appears as. */
export const GAS_ALARM_MODES = ['smoke', 'co'] as const;
export type GasAlarmMode = (typeof GAS_ALARM_MODES)[number];
export const isSensorKind = (kind: string): boolean => (SENSOR_KINDS as readonly string[]).includes(kind);

/** Kinds whose channels may split into separate accessories (sensors and meters never do). */
export const isSplittableKind = (kind: string): boolean => kind === 'switch' || kind === 'cover' || kind === 'dimmer';

/** devices.json kind marker of the triphase total channel (a meter that is hidden by default). */
export const METER_TOTAL_KIND = 'meter-total';

/** Per-channel settings of a multi-channel device; `channel` is 0-based, as on the device. */
export interface ShellyChannelConfig {
  channel?: number;
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

export function channelConfig(entry: ShellyDeviceConfig | undefined, channel: number): ShellyChannelConfig | undefined {
  if (!Array.isArray(entry?.channels)) return undefined;
  return entry.channels.find((c) => c !== null && typeof c === 'object' && c.channel === channel);
}

/**
 * Whether a channel is hidden: its own setting, else the kind's default. The
 * triphase total hides by default - the phases already sum to it, and exposing
 * both would double-count energy in Apple Home's whole-home total.
 */
export const channelHidden = (entry: ShellyDeviceConfig | undefined, channel: number, hiddenByDefault = false): boolean =>
  channelConfig(entry, channel)?.hidden ?? hiddenByDefault;

/** Power metering is on unless the entry switches it off. */
export const powerMeteringEnabled = (entry: ShellyDeviceConfig | undefined): boolean => entry?.powerMetering !== false;

/** The alarm a gas detector is exposed as, or undefined when the entry has not opted in. */
export const gasAlarmMode = (entry: ShellyDeviceConfig | undefined): GasAlarmMode | undefined =>
  (GAS_ALARM_MODES as readonly string[]).includes(entry?.gasAlarm ?? '') ? (entry?.gasAlarm as GasAlarmMode) : undefined;

/** Vibration exposed as a motion sensor only when the entry opts in. */
export const vibrationAsMotionEnabled = (entry: ShellyDeviceConfig | undefined): boolean => entry?.vibrationAsMotion === true;

/**
 * Default presentation: plugs are outlets, wired relay devices usually drive
 * lights. Plug-in devices (Plug S, Plug US/UK/IT, Gen 1 Plug...) all carry
 * 'plug' in the device id.
 */
export const defaultAccessoryType = (deviceId: string): AccessoryType => (deviceId.includes('plug') || deviceId.startsWith('shellyem') ? 'outlet' : 'light');

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
