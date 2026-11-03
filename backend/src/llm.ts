/**
 * The one place model clients are created. Every agent stage asks for its
 * client here instead of building its own, so credentials, gateways and
 * per-stage model choice live in one file.
 *
 *   llm()            the default OpenAI client, shared across stages
 *   llm("review")    the independent reviewer's gateway (REVIEW_AGENT_*), a different provider on purpose
 *   modelFor(stage)  the model a stage runs on: STAGE_MODEL_<STAGE> if set, else the caller's default
 */
import OpenAI from "openai";

const clients = new Map<string, OpenAI>();

export type LlmProfile = "default" | "review";

export function llm(profile: LlmProfile = "default"): OpenAI {
  if (profile === "review") {
    const apiKey = process.env.REVIEW_AGENT_API_KEY;
    const baseURL = process.env.REVIEW_AGENT_BASE_URL;
    if (!apiKey || !baseURL) throw new Error("REVIEW_AGENT_API_KEY / REVIEW_AGENT_BASE_URL environment variables not found");
    const key = `review:${baseURL}:${apiKey}`;
    let client = clients.get(key);
    if (!client) clients.set(key, (client = new OpenAI({ apiKey, baseURL })));
    return client;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not found");
  const key = `default:${apiKey}`;
  let client = clients.get(key);
  if (!client) clients.set(key, (client = new OpenAI({ apiKey })));
  return client;
}

/** The model for one stage. `stage` is the stage id ("triage", "planner", ...); the env var is STAGE_MODEL_<ID in caps>. */
export function modelFor(stage: string, fallback: string): string {
  return process.env[`STAGE_MODEL_${stage.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`]?.trim() || fallback;
}
