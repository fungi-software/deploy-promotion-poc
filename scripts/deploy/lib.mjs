import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const REPO = process.env.GITHUB_REPOSITORY;
export const STATE_BRANCH = "stub-heroku";
export const RUN_URL = `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;

// Mirrors the two Heroku pipelines: each has one app per stage. Only the API app has a release phase.
export const PIPELINES = {
  "api-pipeline": {
    development: "api-development",
    staging: "api-staging",
    production: "api-production",
    releasePhase: true,
  },
  "proxy-pipeline": {
    development: "proxy-development",
    staging: "proxy-staging",
    production: "proxy-production",
    releasePhase: false,
  },
};

// The API pipeline goes first: it migrates the schema the proxy runs on.
export const PIPELINE_ORDER = ["api-pipeline", "proxy-pipeline"];

export const pipelinesFor = (input) =>
  input === "both" ? [...PIPELINE_ORDER] : PIPELINE_ORDER.filter((p) => p === input);

export const sourceStageOf = (target) => (target === "staging" ? "development" : "staging");

export const verifiedContext = (stage, pipeline) =>
  `verified/${stage}${pipeline === "proxy-pipeline" ? "-proxy" : ""}`;

export const short = (sha) => (sha ? sha.slice(0, 7) : "none");

export const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export const policy = () => JSON.parse(readFileSync(".github/deploy-policy.json", "utf8"));

export function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function summary(markdown) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

export async function gh(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

// --- Stub state: JSON files on the stub-heroku branch, written through the contents API.

async function readStateFile(path) {
  const file = await gh("GET", `/repos/${REPO}/contents/${path}?ref=${STATE_BRANCH}`);
  if (!file) return { sha: undefined, data: null };
  return { sha: file.sha, data: JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) };
}

export async function readState(path, fallback) {
  return (await readStateFile(path)).data ?? structuredClone(fallback);
}

export async function updateState(path, change, fallback) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { sha, data } = await readStateFile(path);
    const next = change(data ?? structuredClone(fallback));
    try {
      await gh("PUT", `/repos/${REPO}/contents/${path}`, {
        message: `stub: update ${path}`,
        branch: STATE_BRANCH,
        sha,
        content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`).toString("base64"),
      });
      return next;
    } catch (error) {
      // Two runs wrote at once: re-read and retry.
      if (!/: (409|422) /.test(error.message)) throw error;
      await sleep(1 + Math.random() * 2);
    }
  }
  throw new Error(`Could not update ${path}`);
}

// --- GitHub records: commit statuses and Deployments on the SHA that actually shipped.

export const setStatus = (sha, context, state, description) =>
  gh("POST", `/repos/${REPO}/statuses/${sha}`, {
    state,
    context,
    description: description.slice(0, 140),
    target_url: RUN_URL,
  });

export async function getStatus(sha, context) {
  const combined = await gh("GET", `/repos/${REPO}/commits/${sha}/status?per_page=100`);
  return combined?.statuses.find((status) => status.context === context)?.state ?? "missing";
}

export async function createDeployment(app, sha, stage) {
  const deployment = await gh("POST", `/repos/${REPO}/deployments`, {
    ref: sha,
    environment: app,
    auto_merge: false,
    required_contexts: [],
    description: `${stage} deploy of ${short(sha)}`,
    production_environment: stage === "production",
    payload: { stage },
  });
  return deployment.id;
}

export const setDeploymentStatus = (id, state, description) =>
  gh("POST", `/repos/${REPO}/deployments/${id}/statuses`, {
    state,
    description: description.slice(0, 140),
    log_url: RUN_URL,
    auto_inactive: true,
  });
