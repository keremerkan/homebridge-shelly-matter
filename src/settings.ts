export const PLATFORM_NAME = 'ShellyMatter';
export const PLUGIN_NAME = 'homebridge-shelly-matter';

/**
 * Oldest Homebridge whose Matter stack works with this plugin (composed-parent
 * and deferred-online fixes; homebridge#3972/#3973). Keep in sync with
 * `engines.homebridge` in package.json.
 */
export const MIN_HOMEBRIDGE = '2.2.2-beta.7';

/** Where the platform persists device sightings for the settings UI (under the Homebridge storage path). */
export const DATA_DIR = 'shelly-matter';
export const DEVICES_FILE = 'devices.json';
