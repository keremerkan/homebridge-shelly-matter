/**
 * Conversions between Matter ColorControl values and the channels of Shelly
 * Gen 2+ color lights (`rgb` array, plus `white` in RGBW mode). Brightness is
 * separate on both sides (Matter LevelControl, Shelly `brightness`), so every
 * color here is full intensity.
 */
export type Rgb = [number, number, number];

/** Matter currentHue/currentSaturation span 0-254 (hue: 0-360 degrees). */
const MATTER_MAX = 254;
/** Matter currentX/currentY are the CIE x/y coordinates times 65536 (max 0xfeff). */
const XY_SCALE = 65536;
const XY_MAX = 0xfeff;
/** D65 white point, used for black (no chromaticity). */
const D65 = { x: Math.round(0.3127 * XY_SCALE), y: Math.round(0.329 * XY_SCALE) };

const channel = (value: number): number => Math.round(Math.min(Math.max(value, 0), 255));

export function hueSatToRgb(hue: number, saturation: number): Rgb {
  const h = ((hue / MATTER_MAX) * 6) % 6;
  const s = Math.min(Math.max(saturation / MATTER_MAX, 0), 1);
  const f = h - Math.floor(h);
  const [p, q, t] = [1 - s, 1 - s * f, 1 - s * (1 - f)];
  const rgb = [[1, t, p], [q, 1, p], [p, 1, t], [p, q, 1], [t, p, 1], [1, p, q]][Math.floor(h)];
  return rgb.map((c) => channel(c * 255)) as Rgb;
}

export function rgbToHueSat([r, g, b]: Rgb): { hue: number; saturation: number } {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return { hue: 0, saturation: 0 };
  const h = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: Math.round((h / 6) * MATTER_MAX) % (MATTER_MAX + 1), saturation: Math.round((delta / max) * MATTER_MAX) };
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function xyToRgb(currentX: number, currentY: number): Rgb {
  const x = currentX / XY_SCALE;
  const y = Math.max(currentY / XY_SCALE, 1e-6);
  const [X, Y, Z] = [x / y, 1, (1 - x - y) / y];
  // Out-of-gamut chromaticities clip to zero; the brightest channel is scaled to full.
  const linear = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z].map((c) => Math.max(c, 0));
  const max = Math.max(...linear) || 1;
  return linear.map((c) => channel(toGamma(c / max) * 255)) as Rgb;
}

export function rgbToXy([r, g, b]: Rgb): { x: number; y: number } {
  const [R, G, B] = [r, g, b].map((c) => toLinear(c / 255));
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
  const sum = X + Y + Z;
  if (sum === 0) return D65;
  return { x: Math.min(Math.round((X / sum) * XY_SCALE), XY_MAX), y: Math.min(Math.round((Y / sum) * XY_SCALE), XY_MAX) };
}

/** The color temperature range the light declares (colorTempPhysicalMin/MaxMireds). */
export const MIREDS_MIN = 153;
export const MIREDS_MAX = 500;

/** The RGB mix closest to a white of this color temperature (Tanner Helland's blackbody fit). */
export function miredsToRgb(mireds: number): Rgb {
  const t = 1e6 / Math.max(mireds, 1) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [channel(r), channel(g), channel(b)];
}

/**
 * RGBW colors: the part all three color channels share moves to the white
 * channel, so pale colors use the white LEDs; saturated colors are unchanged.
 */
export function rgbToRgbw(rgb: Rgb): { rgb: Rgb; white: number } {
  const white = Math.min(...rgb);
  return { rgb: rgb.map((c) => c - white) as Rgb, white };
}

/** RGBW color temperature: full white plus only the tint beyond neutral (see rgbToRgbw). */
export const miredsToRgbw = (mireds: number): { rgb: Rgb; white: number } => ({ rgb: rgbToRgbw(miredsToRgb(mireds)).rgb, white: 255 });

/**
 * The color temperature an RGBW mix was written as (a restart forgets the
 * write), or undefined when it is a color: full white plus a tint that
 * matches miredsToRgbw closely enough.
 */
export function miredsFromRgbw(rgb: Rgb, white: number): number | undefined {
  if (white !== 255) return undefined;
  let best: { mireds: number; diff: number } | undefined;
  for (let mireds = MIREDS_MIN; mireds <= MIREDS_MAX; mireds++) {
    const tint = miredsToRgbw(mireds).rgb;
    const diff = rgb.reduce((sum, c, i) => sum + Math.abs(c - tint[i]), 0);
    if (!best || diff < best.diff) best = { mireds, diff };
  }
  return best && best.diff <= 6 ? best.mireds : undefined;
}

/** The color an RGBW mix shows: white adds to all three channels (the inverse of rgbToRgbw). */
export const rgbwToRgb = (rgb: Rgb, white: number): Rgb => rgb.map((c) => channel(c + white)) as Rgb;
