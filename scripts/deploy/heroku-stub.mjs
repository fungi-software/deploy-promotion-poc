// Stands in for the Heroku Platform API. Each app's "release" lives in state/apps/<app>.json on the
// stub-heroku branch; state/control.json injects failures, alarms and dyno counts for demos.
import { PIPELINES, readState, sleep, updateState } from "./lib.mjs";

export const DEFAULT_CONTROL = {
  fail_build: [],
  fail_promote: [],
  e2e_fail: false,
  alarms: { staging: [], production: [] },
  web_dynos: 4,
};

// Seconds. The API build is slower because its release phase runs migrations and collectstatic.
const TIMINGS = {
  "api-pipeline": { build: 45, promote: 20, psWait: 15 },
  "proxy-pipeline": { build: 10, promote: 5, psWait: 5 },
};

const appPath = (app) => `state/apps/${app}.json`;
const emptyRelease = (app) => ({ app, sha: null, status: "none" });

export const getRelease = (app) => readState(appPath(app), emptyRelease(app));

export const getControl = () => readState("state/control.json", DEFAULT_CONTROL);

export const updateControl = (change) => updateState("state/control.json", change, DEFAULT_CONTROL);

const setRelease = (app, patch) =>
  updateState(
    appPath(app),
    (current) => ({ ...current, ...patch, app, updated_at: new Date().toISOString() }),
    emptyRelease(app),
  );

// POST /apps/{app}/builds with source_blob.url = the GitHub tarball and source_blob.version = sha.
export async function build(pipeline, app, sha) {
  await setRelease(app, { status: "pending", pending_sha: sha });
  await sleep(TIMINGS[pipeline].build);
  if ((await getControl()).fail_build.includes(app)) {
    await setRelease(app, { status: "failed", pending_sha: null });
    throw new Error(`stub: build failed on ${app}`);
  }
  await setRelease(app, {
    status: "succeeded",
    sha,
    pending_sha: null,
    release_phase: PIPELINES[pipeline].releasePhase ? "migrate, collectstatic" : "none",
  });
}

// POST /pipeline-promotions: copies the source app's slug, then runs the target's release phase.
export async function promote(pipeline, fromApp, toApp) {
  const source = await getRelease(fromApp);
  await setRelease(toApp, { status: "pending", pending_sha: source.sha });
  await sleep(TIMINGS[pipeline].promote);
  if ((await getControl()).fail_promote.includes(toApp)) {
    await setRelease(toApp, { status: "failed", pending_sha: null });
    throw new Error(`stub: promotion failed on ${toApp}`);
  }
  await setRelease(toApp, { status: "succeeded", sha: source.sha, pending_sha: null });
  return source.sha;
}

// heroku ps:wait: dynos finish restarting onto the new release.
export const psWait = (pipeline) => sleep(TIMINGS[pipeline].psWait);
