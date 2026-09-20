/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as candidates from "../candidates.js";
import type * as collect from "../collect.js";
import type * as crons from "../crons.js";
import type * as drafts from "../drafts.js";
import type * as examples from "../examples.js";
import type * as jobs from "../jobs.js";
import type * as keys from "../keys.js";
import type * as lib_channels from "../lib/channels.js";
import type * as lib_cluster from "../lib/cluster.js";
import type * as lib_keypool from "../lib/keypool.js";
import type * as lib_lint from "../lib/lint.js";
import type * as lib_prompts from "../lib/prompts.js";
import type * as lib_providers from "../lib/providers.js";
import type * as llm from "../llm.js";
import type * as metrics from "../metrics.js";
import type * as omp from "../omp.js";
import type * as owner from "../owner.js";
import type * as publications from "../publications.js";
import type * as seed from "../seed.js";
import type * as settings from "../settings.js";
import type * as signals from "../signals.js";
import type * as sources from "../sources.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  candidates: typeof candidates;
  collect: typeof collect;
  crons: typeof crons;
  drafts: typeof drafts;
  examples: typeof examples;
  jobs: typeof jobs;
  keys: typeof keys;
  "lib/channels": typeof lib_channels;
  "lib/cluster": typeof lib_cluster;
  "lib/keypool": typeof lib_keypool;
  "lib/lint": typeof lib_lint;
  "lib/prompts": typeof lib_prompts;
  "lib/providers": typeof lib_providers;
  llm: typeof llm;
  metrics: typeof metrics;
  omp: typeof omp;
  owner: typeof owner;
  publications: typeof publications;
  seed: typeof seed;
  settings: typeof settings;
  signals: typeof signals;
  sources: typeof sources;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
