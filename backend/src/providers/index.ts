/**
 * The provider registry. To add a swap or bridge service, write a module that
 * implements RouteProvider and list it once here; the router picks it up.
 */
import type { RouteProvider } from "./types.js";
import { enso } from "./enso.js";
import { okxDex } from "./okxDex.js";
import { relay } from "./relay.js";
import { lifi } from "./lifi.js";
import { hashkeySwap } from "./hashkeyswap.js";

export type { RouteProvider, RouteRequest } from "./types.js";

const PROVIDERS: RouteProvider[] = [hashkeySwap, enso, okxDex, relay, lifi];

if (new Set(PROVIDERS.map((p) => `${p.kind}:${p.id}`)).size !== PROVIDERS.length) throw new Error("Duplicate provider in the registry");

export function allProviders(): readonly RouteProvider[] {
  return PROVIDERS;
}
