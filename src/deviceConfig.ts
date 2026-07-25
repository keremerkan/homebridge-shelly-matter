import type { PlatformConfig } from 'homebridge';

export const ACCESSORY_TYPES = ['light', 'outlet', 'switch'] as const;
export type AccessoryType = (typeof ACCESSORY_TYPES)[number];

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
 * Default presentation: plugs are outlets, wired relay devices usually drive
 * lights. Plug-in devices (Plug S, Plug US/UK/IT, Gen 1 Plug...) all carry
 * 'plug' in the device id.
 */
export const defaultAccessoryType = (deviceId: string): AccessoryType => (deviceId.includes('plug') ? 'outlet' : 'light');

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
 * disagree.
 */
export function resolveAccessoryType(config: PlatformConfig, deviceId: string, host?: string, channel?: number): AccessoryType {
  const entry = configForDevice(config, deviceId, host);
  const channelEntry = channel === undefined ? undefined : channelConfig(entry, channel);
  if (channelEntry?.accessoryType && ACCESSORY_TYPES.includes(channelEntry.accessoryType)) return channelEntry.accessoryType;
  if (entry?.accessoryType && ACCESSORY_TYPES.includes(entry.accessoryType)) return entry.accessoryType;
  return defaultAccessoryType(deviceId);
}
