import * as constants from "./constants.js";
import { VOLUME_ICONS } from "./icons.js";
import { state } from "./state.js";

export const runtime = {};

Object.assign(runtime, constants, { state, VOLUME_ICONS });
Object.assign(globalThis, constants, { state, VOLUME_ICONS });

export function register(functions) {
  Object.assign(runtime, functions);
  Object.assign(globalThis, functions);
}
