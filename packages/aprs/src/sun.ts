// SPDX-License-Identifier: MIT
/**
 * sun.ts — solar geometry for the day/night terminator overlay. Low-precision but
 * map-accurate: the subsolar point (where the sun is overhead) and the terminator latitude at a
 * given longitude. Pure + runtime-neutral.
 */
const RAD = Math.PI / 180;

/** The point where the sun is directly overhead at `unixSec` (subsolar lat = declination, lon). */
export function subsolarPoint(unixSec: number): { lat: number; lon: number } {
  const jd = unixSec / 86400 + 2440587.5; // Julian date
  const n = jd - 2451545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360; // mean longitude (deg)
  const g = (357.528 + 0.9856003 * n) % 360; // mean anomaly (deg)
  const lambda = (L + 1.915 * Math.sin(g * RAD) + 0.02 * Math.sin(2 * g * RAD)) * RAD; // ecliptic long
  const eps = (23.439 - 0.0000004 * n) * RAD; // obliquity of the ecliptic
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / RAD; // declination
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD; // right ascension
  const gmst = (280.46061837 + 360.98564736629 * n) % 360; // Greenwich mean sidereal time
  const lon = ((ra - gmst + 540) % 360) - 180; // subsolar longitude = RA − GMST, wrapped to [-180,180)
  return { lat: dec, lon };
}

/** Latitude (deg, −90..90) of the day/night terminator at `lonDeg`, given the subsolar point. */
export function terminatorLatitude(lonDeg: number, sub: { lat: number; lon: number }): number {
  return Math.atan(-Math.cos((lonDeg - sub.lon) * RAD) / Math.tan(sub.lat * RAD)) / RAD;
}
