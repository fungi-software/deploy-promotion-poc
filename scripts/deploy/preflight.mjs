// Blockers only: conditions at the target stage, or a source deployment that isn't verified.
// Alarms on the target are reported but never block, so a hotfix can always ship.
import * as heroku from "./heroku-stub.mjs";
import {
  getStatus,
  gh,
  git,
  output,
  PIPELINES,
  pipelinesFor,
  policy,
  REPO,
  short,
  sourceStageOf,
  summary,
  verifiedContext,
} from "./lib.mjs";

const target = process.env.TARGET;
const source = sourceStageOf(target);
const pipelines = pipelinesFor(process.env.PIPELINE);
const expedite = process.env.EXPEDITE === "true";
const expediteReason = (process.env.EXPEDITE_REASON ?? "").trim();
const workerOrder = (process.env.WORKER_ORDER ?? "").trim();
const rules = policy();
const control = await heroku.getControl();

if (expedite && !expediteReason) {
  console.error("expedite needs expedite_reason");
  process.exit(1);
}

const sourceReleases = {};
const targetReleases = {};
for (const pipeline of pipelines) {
  sourceReleases[pipeline] = await heroku.getRelease(PIPELINES[pipeline][source]);
  targetReleases[pipeline] = await heroku.getRelease(PIPELINES[pipeline][target]);
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
const describe = (releases, stage) =>
  pipelines.map((p) => `${PIPELINES[p][stage]} ${short(releases[p].sha)} (${releases[p].status})`).join(", ");

const sha = sourceReleases[pipelines[0]].sha;
const sourceShas = [...new Set(pipelines.map((p) => sourceReleases[p].sha))];

check(
  "Source deployed",
  pipelines.every((p) => sourceReleases[p].sha && sourceReleases[p].status === "succeeded"),
  describe(sourceReleases, source),
);
if (pipelines.length > 1) {
  check("Pipelines on one SHA", sourceShas.length === 1, sourceShas.map(short).join(" vs "));
}

if (sha) {
  if (source === "development") {
    const state = await getStatus(sha, "deployed/development");
    check("deployed/development", state === "success", `${state} on ${short(sha)}`);
  } else {
    for (const pipeline of pipelines) {
      const context = verifiedContext("staging", pipeline);
      const state = await getStatus(sourceReleases[pipeline].sha, context);
      check(`Source verified (${context})`, state === "success", `${state} on ${short(sourceReleases[pipeline].sha)}`);
    }
  }

  let onMain = true;
  try {
    git("merge-base", "--is-ancestor", sha, "origin/main");
  } catch {
    onMain = false;
  }
  check("SHA on main", onMain, short(sha));
}

check(
  "No deploy in progress",
  pipelines.every((p) => targetReleases[p].status !== "pending"),
  describe(targetReleases, target),
);

const now = etParts(new Date());
const freeze = (rules.freezes ?? []).find((f) => now.date >= f.start && now.date <= f.end);
check("No freeze", !freeze, freeze ? `${freeze.reason}, ${freeze.start} to ${freeze.end}` : "none active");

// The proxy has no release phase, so it must not run code whose migrations the API app hasn't applied.
if (sha && pipelines.length === 1 && pipelines[0] === "proxy-pipeline") {
  const api = await heroku.getRelease(PIPELINES["api-pipeline"][target]);
  const applied = api.sha ? migrationsAt(api.sha) : [];
  const missing = migrationsAt(sha).filter((m) => !applied.includes(m));
  check(
    "Proxy not past schema",
    missing.length === 0,
    missing.length ? `${PIPELINES["api-pipeline"][target]} lacks ${missing.join(", ")}` : "schema is in place",
  );
}

const base = targetReleases[pipelines[0]].sha;
const commits = sha ? rangeCommits(base, sha) : [];
const prs = await pullRequestsFor(commits);

if (target === "production") {
  const window = rules.production_window;
  const risky = prs.filter((pr) => pr.labels.some((label) => new RegExp(window.risk_label_pattern).test(label)));
  const opens = risky.length ? window.risk_start_hour : window.start_hour;
  const inside = window.days.includes(now.weekday) && now.hour >= opens && now.hour < window.end_hour;
  check(
    "Inside deploy hours",
    inside,
    `${now.weekday} ${now.time} ET; window ${window.days.join("/")} ${opens}:00-${window.end_hour}:00` +
      (risky.length ? ` (later start for ${risky.map((pr) => `#${pr.number}`).join(", ")})` : ""),
  );

  if (pipelines.includes("api-pipeline")) {
    check("Web dynos", control.web_dynos >= rules.min_web_dynos, `${control.web_dynos} up, need ${rules.min_web_dynos}`);
  }

  const workerFiles = base ? git("diff", "--name-only", base, sha, "--", "worker/") : "";
  check(
    "Worker order set",
    !workerFiles || Boolean(workerOrder),
    workerFiles ? `worker/ changed; worker_order: ${workerOrder || "empty"}` : "no worker change",
  );
}

const alarms = control.alarms[target] ?? [];
const blocked = checks.filter((c) => !c.ok);

summary(`## Preflight: ${source} → ${target} (${pipelines.join(", ")})\n`);
summary("| | Check | Detail |\n| --- | --- | --- |");
for (const c of checks) {
  const mark = c.ok ? "✅" : expedite ? "⏭️ bypassed" : "❌";
  summary(`| ${mark} | ${c.name} | ${c.detail} |`);
}
summary(`| ℹ️ | ${target} alarms (not a blocker) | ${alarms.length ? alarms.join(", ") : "none alerting"} |`);
summary(`\nRange: ${base ? `\`${short(base)}..${short(sha)}\`` : `first deploy of \`${short(sha)}\``}, ${commits.length} commits, PRs ${prs.map((pr) => `#${pr.number}`).join(" ") || "none"}`);
if (expedite) summary(`\n**Expedited:** ${expediteReason}`);

output("sha", sha ?? "");
output("pipelines", JSON.stringify(pipelines));
output("prs", JSON.stringify(prs.map((pr) => pr.number)));

if (blocked.length && !expedite) {
  console.error(`Blocked: ${blocked.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

function etParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: rules.timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
    time: `${parts.hour}:${parts.minute}`,
  };
}

function migrationsAt(ref) {
  return git("ls-tree", "--name-only", ref, "app/migrations/").split("\n").filter(Boolean);
}

function rangeCommits(from, to) {
  const range = from ? [`${from}..${to}`] : ["--max-count=20", to];
  return git("rev-list", ...range).split("\n").filter(Boolean);
}

async function pullRequestsFor(shas) {
  const found = new Map();
  for (const commit of shas) {
    for (const pr of (await gh("GET", `/repos/${REPO}/commits/${commit}/pulls`)) ?? []) {
      if (pr.merged_at) found.set(pr.number, { number: pr.number, labels: pr.labels.map((l) => l.name) });
    }
  }
  return [...found.values()];
}
