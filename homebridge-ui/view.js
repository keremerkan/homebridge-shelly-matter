import { ACCESSORY_TYPES, channelConfig, configForDevice, defaultAccessoryType, resolveAccessoryType, splitChannelsEnabled } from '../dist/deviceConfig.js';

/**
 * The settings table's view/apply logic, computed with the plugin's own config
 * rules (dist/deviceConfig.js) so the UI can never drift from what the
 * platform registers. Pure functions - server.js wires them to requests, and
 * they are importable for tests without starting the UI server.
 */

/** Component kinds with no hardware confirmation yet (per-model status lives in the README device table). */
const UNTESTED_KINDS = ['cover'];

/** Read-only sensor kinds: no accessory type choice, no splitting, one physical unit. */
const SENSOR_KINDS = ['temperature', 'humidity', 'flood'];

/**
 * Everything the settings table needs per device. Takes the UI's current
 * (possibly unsaved) config so edits resolve live. Switch channels carry a
 * configurable type; cover/dimmer channels have a fixed kind (no dropdown).
 */
export function deviceView({ config, devices } = {}) {
  const platformConfig = config && typeof config === 'object' ? config : {};
  const rows = (Array.isArray(devices) ? devices : [])
    .filter((device) => typeof device?.id === 'string')
    .map((device) => {
      const entry = configForDevice(platformConfig, device.id, device.host);
      const channelCount = Number(device.channels) > 1 ? Number(device.channels) : 0;
      const kindOf = (channel) => (Array.isArray(device.kinds) ? device.kinds[channel] : undefined) ?? 'switch';
      const typeOf = (channel) => (kindOf(channel ?? 0) === 'switch' ? resolveAccessoryType(platformConfig, device.id, device.host, channel) : kindOf(channel ?? 0));
      return {
        id: device.id,
        kind: kindOf(0),
        defaultType: defaultAccessoryType(device.id),
        type: typeOf(undefined),
        channelKinds: Array.from({ length: channelCount }, (_, i) => kindOf(i)),
        channelTypes: Array.from({ length: channelCount }, (_, i) => typeOf(i)),
        channelNames: Array.from({ length: channelCount }, (_, i) => channelConfig(entry, i)?.name ?? ''),
        channelsHidden: Array.from({ length: channelCount }, (_, i) => {
          const hidden = channelConfig(entry, i)?.hidden;
          // The triphase total channel is hidden by default (double-counting).
          return kindOf(i) === 'meter-total' ? hidden !== false : hidden === true;
        }),
        name: entry?.name ?? '',
        hidden: entry?.hidden === true,
        split: splitChannelsEnabled(entry),
        sensor: Array.isArray(device.kinds) && device.kinds.length > 0 && device.kinds.every((kind) => SENSOR_KINDS.includes(kind)),
        splittable: !Array.isArray(device.kinds) || device.kinds.every((kind) => ['switch', 'cover', 'dimmer'].includes(kind)),
        sensorKinds: Array.isArray(device.kinds) ? device.kinds.filter((kind) => SENSOR_KINDS.includes(kind)) : [],
      };
    });
  return { types: [...ACCESSORY_TYPES], untested: UNTESTED_KINDS, rows };
}

/**
 * Rebuilds the config's devices array from the settings table's selections.
 * The entry-shape policy (host auto-fill, explicit types, nested channels,
 * powerMetering carry-over) lives here with the rest of the config rules;
 * the browser page only harvests neutral DOM values.
 */
export function applyView({ config, devices, selections } = {}) {
  const platformConfig = config && typeof config === 'object' ? config : {};
  const list = (Array.isArray(devices) ? devices : []).filter((device) => typeof device?.id === 'string');
  const chosen = new Map((Array.isArray(selections) ? selections : []).map((sel) => [sel.id, sel]));
  // Preserve entries for devices not in this listing.
  const listedIds = new Set(list.map((device) => device.id));
  const listedHosts = new Set(list.map((device) => device.host));
  const entries = Array.isArray(platformConfig.devices) ? platformConfig.devices.filter((e) => e && typeof e === 'object') : [];
  const rebuilt = entries.filter((e) => {
    if (e.device && listedIds.has(e.device)) return false;
    if (!e.device && e.host && listedHosts.has(e.host)) return false;
    return true;
  });

  for (const device of list) {
    const prior = configForDevice(platformConfig, device.id, device.host);
    const sel = chosen.get(device.id);
    // Always record the current IP so the plugin keeps working if mDNS
    // discovery is disabled later; with mDNS on it is harmlessly redundant.
    const entry = { device: device.id, host: device.host || prior?.host };
    if (!entry.host) delete entry.host;
    if (sel?.name) entry.name = sel.name;
    // Write the type explicitly (even when it matches the default) so the
    // devices list in the schema form shows the effective value, not blank.
    // Multi-channel devices carry no parent type - each channel has its own.
    if (sel?.type) entry.accessoryType = sel.type;
    // Power metering is configured in the schema form, not the table - carry it over.
    if (prior?.powerMetering === false) entry.powerMetering = false;
    if (sel?.hidden === true) entry.hidden = true;
    // Split is the default; only the grouped choice is a deviation worth recording.
    if (sel?.split === false) entry.splitChannels = false;
    // Cover/dimmer channels have no type dropdown, so their selections carry
    // no type; record a channel only when something is actually set.
    const kinds = Array.isArray(device.kinds) ? device.kinds : [];
    const channels = (Array.isArray(sel?.channels) ? sel.channels : [])
      .map(({ channel, name, type, hidden }) => {
        const channelEntry = { channel };
        if (name) channelEntry.name = name;
        if (type) channelEntry.accessoryType = type;
        // The triphase total channel is hidden by DEFAULT, so only the
        // opt-in (unchecking hide) is a deviation worth recording.
        if (kinds[channel] === 'meter-total') {
          if (hidden === false) channelEntry.hidden = false;
        } else if (hidden === true) {
          channelEntry.hidden = true;
        }
        return channelEntry;
      })
      .filter((channelEntry) => channelEntry.accessoryType !== undefined || channelEntry.hidden !== undefined || channelEntry.name !== undefined);
    if (channels.length > 0) entry.channels = channels;
    rebuilt.push(entry);
  }
  return rebuilt;
}
