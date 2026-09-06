export const PLATFORM_NAME = 'ShellyMatter';
export const PLUGIN_NAME = 'homebridge-shelly-matter';

/**
 * Oldest Homebridge whose Matter stack works with this plugin (composed-parent
 * and deferred-online fixes; homebridge#3972/#3973). Keep in sync with
 * `engines.homebridge` in package.json.
 */
export const MIN_HOMEBRIDGE = '2.3.0';

/** Where the platform persists device sightings for the settings UI (under the Homebridge storage path). */
export const DATA_DIR = 'shelly-matter';
export const DEVICES_FILE = 'devices.json';

/**
 * A real Shelly device id: model slug + a MAC fragment of at least 6 hex
 * chars. The mDNS scanner matches any name starting with 'shelly', so this
 * filters name-alikes (e.g. a HAP bridge someone named "Shelly...").
 */
export const SHELLY_ID_PATTERN = /^shelly[a-z0-9]*-[0-9a-f]{6,}$/i;
/** Devices running unofficial firmware advertise on this port; the plugin skips them. */
export const UNOFFICIAL_FIRMWARE_PORT = 9000;
/** Whether an mDNS sighting is a Shelly this plugin will talk to. */
export const isShellyDiscovery = ({ id, port }: { id: string; port?: number }): boolean => SHELLY_ID_PATTERN.test(id) && port !== UNOFFICIAL_FIRMWARE_PORT;
