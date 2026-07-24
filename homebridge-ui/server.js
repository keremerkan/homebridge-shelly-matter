import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

import { ACCESSORY_TYPES, channelConfig, configForDevice, defaultAccessoryType, resolveAccessoryType } from '../dist/deviceConfig.js';
import { MdnsScanner } from '../dist/shelly/mdnsScanner.js';

const SCAN_DURATION_MS = 5000;
const RPC_TIMEOUT_MS = 2500;

// Matter vendor ids seen commissioning a bridge, mapped to friendly names.
// Apple enrolls two fabrics per home: the home-labelled AppleHome fabric and
// an unlabelled Keychain fabric (see the plugin README/notes).
const VENDOR_NAMES = {
  0x1349: 'Apple Home',
  0x1384: 'Apple Keychain',
  0x1385: 'Apple Keychain',
  0x6006: 'Google Home',
  0x1217: 'Amazon',
  0x1049: 'Samsung SmartThings',
};

class ShellyMatterUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/devices', () => this.knownDevices());
    this.onRequest('/scan', () => this.scan());
    this.onRequest('/fabrics', () => this.fabrics());
    this.onRequest('/device-view', (payload) => this.deviceView(payload));
    this.ready();
  }

  /**
   * Everything the settings table needs per device, resolved with the plugin's
   * own config rules (dist/deviceConfig.js) - the browser page stays pure
   * presentation and can never drift from what the platform will register.
   * Takes the UI's current (possibly unsaved) config so edits resolve live.
   */
  deviceView({ config, devices } = {}) {
    const platformConfig = config && typeof config === 'object' ? config : {};
    const rows = (Array.isArray(devices) ? devices : [])
      .filter((device) => typeof device?.id === 'string')
      .map((device) => {
        const entry = configForDevice(platformConfig, device.id, device.host);
        const channelCount = Number(device.channels) > 1 ? Number(device.channels) : 0;
        return {
          id: device.id,
          defaultType: defaultAccessoryType(device.id),
          type: resolveAccessoryType(platformConfig, device.id, device.host),
          channelTypes: Array.from({ length: channelCount }, (_, i) => resolveAccessoryType(platformConfig, device.id, device.host, i)),
          channelsHidden: Array.from({ length: channelCount }, (_, i) => channelConfig(entry, i)?.hidden === true),
          name: entry?.name ?? '',
          hidden: entry?.hidden === true,
          host: entry?.host,
          powerMetering: entry?.powerMetering,
        };
      });
    return { types: [...ACCESSORY_TYPES], rows };
  }

  /**
   * The controllers (Matter fabrics) currently commissioned on the bridge,
   * read from the Matter node's persisted storage. Replaces the bare "paired"
   * indicator with who is actually connected; empty means not yet paired.
   */
  async fabrics() {
    try {
      const config = JSON.parse(await readFile(this.homebridgeConfigPath, 'utf8'));
      const platform = (config.platforms ?? []).find((p) => p.platform === 'ShellyMatter');
      const username = platform?._bridge?.username;
      if (!username) return [];
      const bridgeId = username.replace(/:/g, '');
      // A bridge id is a 12-hex-digit MAC without separators; reject anything
      // else so a crafted username cannot escape the matter storage directory.
      if (!/^[0-9a-f]{12}$/i.test(bridgeId)) return [];
      const file = await this.findFabricsFile(join(this.homebridgeStoragePath, 'matter', bridgeId), bridgeId);
      if (!file) return [];
      const unwrap = (value) => {
        if (typeof value !== 'string' || !value.startsWith('{')) return value;
        try { return JSON.parse(value).__value__ ?? value; } catch { return value; }
      };
      const fabrics = JSON.parse(await readFile(file, 'utf8'));
      return (Array.isArray(fabrics) ? fabrics : []).map((fabric) => ({
        index: fabric.fabricIndex ?? 0,
        vendor: VENDOR_NAMES[fabric.rootVendorId] ?? `Vendor 0x${Number(fabric.rootVendorId ?? 0).toString(16)}`,
        label: fabric.label || '',
        fabricId: String(unwrap(fabric.fabricId) ?? ''),
        nodeId: String(unwrap(fabric.nodeId) ?? ''),
      }));
    } catch {
      return [];
    }
  }

  /** Locates the matter.js node's fabrics store (nested one dir below the bridge id). */
  async findFabricsFile(base, bridgeId) {
    const direct = join(base, bridgeId, 'fabrics.fabrics');
    try {
      await readFile(direct);
      return direct;
    } catch { /* fall through to a shallow search */ }
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(base, entry.name, 'fabrics.fabrics');
        try { await readFile(candidate); return candidate; } catch { /* keep looking */ }
      }
    } catch { /* no matter storage yet */ }
    return undefined;
  }

  /** Devices the running platform has seen, persisted to devices.json. */
  async knownDevices() {
    try {
      const file = join(this.homebridgeStoragePath, 'shelly-matter', 'devices.json');
      const devices = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(devices) ? devices : [];
    } catch {
      return [];
    }
  }

  /**
   * Discovers Shelly devices with a short mDNS scan, then enriches Gen 2+
   * devices with their configured name and switch channel count over HTTP.
   * Password-protected or unreachable devices stay unenriched (channels null).
   */
  async scan() {
    const found = new Map();
    for (const device of await this.knownDevices()) found.set(device.id, device);
    const scanner = new MdnsScanner();
    scanner.on('discovered', (device) => found.set(device.id, { ...found.get(device.id), ...device }));
    scanner.start();
    // start() sends its first query possibly before the socket is bound and
    // only re-queries after 60s; re-fire every second so a short scan works.
    const requery = setInterval(() => scanner.sendQuery(), 1000);
    await new Promise((resolve) => setTimeout(resolve, SCAN_DURATION_MS));
    clearInterval(requery);
    scanner.stop();

    const devices = [...found.values()];
    await Promise.all(
      devices.map(async (device) => {
        if (device.gen < 2) return;
        // device.host comes from an mDNS record; only enrich real hostnames/IPs
        // so a crafted responder cannot reshape the URL or redirect us at an
        // internal service (SSRF).
        if (typeof device.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(device.host)) return;
        try {
          const res = await fetch(`http://${device.host}/rpc/Shelly.GetConfig`, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS), redirect: 'error' });
          if (!res.ok) return;
          const config = await res.json();
          device.name = config.sys?.device?.name ?? null;
          // The plugin's devices.json channel count is authoritative (it comes
          // from the live component model); the key-prefix scan only fills in
          // for devices the plugin has not seen yet.
          device.channels ??= Object.keys(config).filter((key) => key.startsWith('switch:')).length || null;
        } catch {
          // leave unenriched
        }
      }),
    );
    return devices.sort((a, b) => a.id.localeCompare(b.id));
  }
}

(() => new ShellyMatterUiServer())();
