import type { Light } from "three";

export type OceanLightRole =
  | "sun"
  | "moon"
  | "boat-work"
  | "flashlight-spot"
  | "flashlight-spill"
  | "cabin"
  | "nav-port"
  | "nav-starboard"
  | "anchor"
  | "lightning"
  | "generic";

const OCEAN_LIGHT_ROLES = new Set<OceanLightRole>([
  "sun",
  "moon",
  "boat-work",
  "flashlight-spot",
  "flashlight-spill",
  "cabin",
  "nav-port",
  "nav-starboard",
  "anchor",
  "lightning",
  "generic"
]);

const warnedLights = new WeakSet<Light>();

export function tagOceanLight<T extends Light>(light: T, role: Exclude<OceanLightRole, "generic">): T {
  light.userData.oceanLightRole = role;
  return light;
}

export function getOceanLightRole(light: Light): OceanLightRole {
  const role = light.userData.oceanLightRole;
  if (typeof role === "string" && OCEAN_LIGHT_ROLES.has(role as OceanLightRole)) {
    return role as OceanLightRole;
  }

  if (import.meta.env.DEV && !warnedLights.has(light)) {
    warnedLights.add(light);
    console.warn(`[Ocean] Direct light "${light.name || light.type}" has no ocean role; using generic.`);
  }
  return "generic";
}

export function isOceanCelestialRole(role: OceanLightRole): role is "sun" | "moon" {
  return role === "sun" || role === "moon";
}
