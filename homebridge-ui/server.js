import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

import { DATA_DIR, DEVICES_FILE, FORGET_FILE, isShellyDiscovery, PLATFORM_NAME } from '../dist/settings.js';
import { MdnsScanner } from '../dist/shelly/mdnsScanner.js';
import { applyView, deviceView } from './view.js';

const SCAN_DURATION_MS = 5000;
const RPC_TIMEOUT_MS = 2500;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
    this.onRequest('/forget', ({ id } = {}) => this.forget(id));
    this.onRequest('/fabrics', () => this.fabrics());
    this.onRequest('/device-view', (payload) => deviceView(payload));
    this.onRequest('/apply-view', (payload) => applyView(payload));
    this.ready();
  }

  /**
   * The controllers (Matter fabrics) currently commissioned on the bridge,
   * read from the Matter node's persisted storage. Replaces the bare "paired"
   * indicator with who is actually connected; empty means not yet paired.
   */
  async fabrics() {
    try {
      const config = JSON.parse(await readFile(this.homebridgeConfigPath, 'utf8'));
      const platform = (config.platforms ?? []).find((p) => p.platform === PLATFORM_NAME);
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

  /** Locates the matter.js node's fabrics store (one dir below the bridge id; the bridge's own dir is tried first). */
  async findFabricsFile(base, bridgeId) {
    let names = [];
    try {
      names = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch { /* no matter storage yet */ }
    for (const name of [bridgeId, ...names.filter((name) => name !== bridgeId)]) {
      const candidate = join(base, name, 'fabrics.fabrics');
      try { await readFile(candidate); return candidate; } catch { /* keep looking */ }
    }
    return undefined;
  }

  /** Devices the running platform has seen, persisted to devices.json - minus the forgotten ones (tombstones and requests not applied yet). */
  async knownDevices() {
    try {
      const file = join(this.homebridgeStoragePath, DATA_DIR, DEVICES_FILE);
      const devices = JSON.parse(await readFile(file, 'utf8'));
      const pending = new Set(await this.forgetRequests());
      return (Array.isArray(devices) ? devices : []).filter((device) => device?.forgotten !== true && !pending.has(device?.id));
    } catch {
      return [];
    }
  }

  /** Ids waiting in forget.json for the platform's next startup. */
  async forgetRequests() {
    try {
      const ids = JSON.parse(await readFile(join(this.homebridgeStoragePath, DATA_DIR, FORGET_FILE), 'utf8'));
      return (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && DEVICE_ID.test(id));
    } catch {
      return [];
    }
  }

  /**
   * Asks the platform to drop a device at its next startup (accessories,
   * saved state, table row). Only the platform may touch devices.json and the
   * Matter cache - a rewrite from here would be overwritten by its in-memory
   * list - so the request travels in a file of its own.
   */
  async forget(id) {
    if (typeof id !== 'string' || !DEVICE_ID.test(id)) throw new Error('Invalid device id');
    return this.writeForgetRequests([...new Set([...(await this.forgetRequests()), id])]);
  }

  async writeForgetRequests(ids) {
    const file = join(this.homebridgeStoragePath, DATA_DIR, FORGET_FILE);
    await writeFile(`${file}.tmp`, JSON.stringify(ids));
    await rename(`${file}.tmp`, file);
    return ids;
  }

  /**
   * Discovers Shelly devices with a short mDNS scan, then enriches Gen 2+
   * devices with their configured name and switch channel count over HTTP.
   * Password-protected or unreachable devices stay unenriched (channels null).
   */
  async scan() {
    const found = new Map();
    const seen = new Set();
    for (const device of await this.knownDevices()) found.set(device.id, device);
    const scanner = new MdnsScanner();
    scanner.on('discovered', (device) => {
      if (!isShellyDiscovery(device)) return; // same filter as the platform
      seen.add(device.id);
      found.set(device.id, { ...found.get(device.id), ...device });
    });
    scanner.start();
    // start() sends its first query possibly before the socket is bound and
    // only re-queries after 60s; re-fire every second so a short scan works.
    const requery = setInterval(() => scanner.sendQuery(), 1000);
    await sleep(SCAN_DURATION_MS);
    clearInterval(requery);
    scanner.stop();

    // A device that answered is on the network and comes back anyway: a pending forget would only rotate it for nothing.
    const pending = await this.forgetRequests();
    if (pending.some((id) => seen.has(id))) await this.writeForgetRequests(pending.filter((id) => !seen.has(id)));

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
