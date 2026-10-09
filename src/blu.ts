import EventEmitter from 'node:events';

import { ShellyComponent } from './shelly/shellyComponent.js';
import type { ShellyDevice } from './shelly/shellyDevice.js';
import { shellyFetch } from './shelly/shellyFetch.js';
import type { ShellyDataType } from './shelly/shellyTypes.js';

/** The BLU TRV's setpoint range (°C); its minimum is the frost protection a Matter "Off" maps to. */
export const TRV_MIN_C = 4;
export const TRV_MAX_C = 30;

/**
 * Where a BLU sensor reading lands: a component named like the ones the
 * protocol layer gives Shelly sensor products, so the existing mapping
 * applies. Motion gets its own name - Gen 1 Shelly Motion units already have
 * a 'Motion' component, fed differently.
 */
const SENSOR_TARGETS: Record<string, (idx: number) => { id: string; name: string; property: string }> = {
  Battery: () => ({ id: 'battery', name: 'Battery', property: 'level' }),
  Temperature: (idx) => ({ id: `temperature:${idx}`, name: 'Temperature', property: 'tC' }),
  Humidity: (idx) => ({ id: `humidity:${idx}`, name: 'Humidity', property: 'rh' }),
  Illuminance: (idx) => ({ id: `lux:${idx}`, name: 'Lux', property: 'value' }),
  Motion: (idx) => ({ id: `blumotion:${idx}`, name: 'BluMotion', property: 'motion' }),
  // BTHome contact: 1 / true = open.
  Contact: (idx) => ({ id: `sensor:${idx}`, name: 'Sensor', property: 'contact_open' }),
};

/** A BLU TRV reports its setpoint as temperature 0 and the room temperature as temperature 1. */
const TRV_TEMPERATURES = ['target_C', 'current_C'];

/**
 * A BLU device paired to a Shelly gateway, presented to the plugin as a
 * device of its own: own identity, config entry and accessory. It holds
 * protocol-layer components fed from the gateway's BTHome reports; commands
 * (the TRV setpoint) go through the gateway.
 */
export class BluDevice extends EventEmitter {
  readonly id: string;
  readonly mac: string;
  readonly gen = 0;
  readonly host = '';
  readonly port = 80;
  readonly sleepMode = false;
  readonly udp = false;
  readonly profile = undefined;
  readonly firmware = undefined;
  readonly log: ShellyDevice['log'];
  readonly shelly: ShellyDevice['shelly'];
  private readonly components = new Map<string, ShellyComponent>();

  constructor(
    readonly gateway: ShellyDevice,
    readonly name: string,
    readonly model: string,
    addr: string,
    private readonly trvId?: number,
  ) {
    super();
    this.mac = addr.replace(/:/g, '').toUpperCase();
    this.id = `shellyblu-${this.mac}`;
    this.log = gateway.log;
    this.shelly = gateway.shelly;
  }

  getComponent(id: string): ShellyComponent | undefined {
    return this.components.get(id);
  }

  /** In id order: every BLU reading is index 0, so the order they were first reported in must not decide the part order (and with it the identity). */
  *[Symbol.iterator](): IterableIterator<[string, ShellyComponent]> {
    yield* [...this.components].sort(([a], [b]) => a.localeCompare(b));
  }

  /** Applies a sensor reading (the gateway's scan or a live report). */
  report(sensorName: string, idx: number, value: ShellyDataType): void {
    const trvTemperature = this.trvId !== undefined && sensorName === 'Temperature' ? TRV_TEMPERATURES[idx] : undefined;
    const target = trvTemperature ? { id: 'blutrv:0', name: 'BluTrv', property: trvTemperature } : SENSOR_TARGETS[sensorName]?.(idx);
    if (!target) return;
    const converted = target.property === 'contact_open' ? value === true || value === 1 : value;
    const component = this.components.get(target.id);
    if (component) component.setValue(target.property, converted);
    else this.components.set(target.id, new ShellyComponent(this as unknown as ShellyDevice, target.id, target.name, { [target.property]: converted }));
  }

  /** Sets the TRV's target temperature through the gateway. */
  setTrvTarget(celsius: number): void {
    if (this.trvId === undefined) return;
    const target_C = Math.min(TRV_MAX_C, Math.max(TRV_MIN_C, Math.round(celsius * 10) / 10));
    void shellyFetch(this.gateway.shelly, this.gateway.log, this.gateway.host, this.gateway.port, 'BluTrv.Call', { id: this.trvId, method: 'Trv.SetTarget', params: { id: 0, target_C } });
  }
}

/** The BLU devices paired to a gateway, with their last reported values and live updates wired. */
export function bluDevicesOf(gateway: ShellyDevice): BluDevice[] {
  const byAddr = new Map<string, BluDevice>();
  for (const info of gateway.bthomeDevices.values()) {
    // Unnamed devices get the protocol layer's "<model> <address>": too long for a Matter label, so "<model> <last 4 hex digits>".
    const name = info.name === `${info.model} ${info.addr}` ? `${info.model.replace(/^Shelly /, '')} ${info.addr.replace(/:/g, '').slice(-4).toUpperCase()}` : info.name;
    byAddr.set(info.addr, new BluDevice(gateway, name, info.model, info.addr, gateway.bthomeTrvs.get(info.addr)?.id));
  }
  for (const sensor of gateway.bthomeSensors.values()) {
    if (sensor.value !== undefined && sensor.value !== null) byAddr.get(sensor.addr)?.report(gateway.getBTHomeObjIdText(sensor.sensorId), sensor.sensorIdx, sensor.value);
  }
  gateway.on('bthomesensor_update', (addr: string, sensorName: string, idx: number, value: ShellyDataType) => byAddr.get(addr)?.report(sensorName, idx, value));
  return [...byAddr.values()];
}
