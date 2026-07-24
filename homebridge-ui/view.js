import { ACCESSORY_TYPES, channelConfig, configForDevice, defaultAccessoryType, resolveAccessoryType } from '../dist/deviceConfig.js';

/**
 * The settings table's view/apply logic, computed with the plugin's own config
 * rules (dist/deviceConfig.js) so the UI can never drift from what the
 * platform registers. Pure functions - server.js wires them to requests, and
 * they are importable for tests without starting the UI server.
 */

/** Component kinds newly supported but not yet validated on real hardware; the UI badges them. */
const UNTESTED_KINDS = ['cover', 'dimmer'];

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
        channelsHidden: Array.from({ length: channelCount }, (_, i) => channelConfig(entry, i)?.hidden === true),
        name: entry?.name ?? '',
        hidden: entry?.hidden === true,
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
    // Cover/dimmer channels have no type dropdown, so their selections carry
    // no type; record them only when something (hidden) is actually set.
    const channels = (Array.isArray(sel?.channels) ? sel.channels : [])
      .map(({ channel, type, hidden }) => {
        const channelEntry = { channel };
        if (type) channelEntry.accessoryType = type;
        if (hidden === true) channelEntry.hidden = true;
        return channelEntry;
      })
      .filter((channelEntry) => channelEntry.accessoryType !== undefined || channelEntry.hidden === true);
    if (channels.length > 0) entry.channels = channels;
    rebuilt.push(entry);
  }
  return rebuilt;
}
