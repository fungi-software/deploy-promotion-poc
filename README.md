# Deploy promotion PoC

A working demo of a three-stage promotion flow (development → staging → production) for two
Heroku-style pipelines, driven entirely from GitHub Actions. Heroku and Datadog are stubbed; every
GitHub piece is real: workflows, environments, commit statuses, Deployments and PR labels.

The model: **each deployment is verified after it lands, and the next promotion waits only on
blockers.** Alarms on the target stage never block, so a hotfix can always ship.

## Pipelines

| Pipeline | development | staging | production | Release phase |
| --- | --- | --- | --- | --- |
| `api-pipeline` | `api-development` | `api-staging` | `api-production` | yes (migrations) |
| `proxy-pipeline` | `proxy-development` | `proxy-staging` | `proxy-production` | no |

With `pipeline: both`, the API goes first: the proxy runs on the schema the API's release phase migrates.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push, PR | Tests. |
| `deploy-dev.yml` | CI green on a `main` push | Builds both development apps from the SHA, records a Deployment per app, then posts `deployed/development` once **both** run it. Replaces Heroku auto-deploy. |
| `promote.yml` | by hand: `target`, `pipeline` | `preflight` checks blockers and writes the step summary; `promote` copies the source slug to each target app in order, records Deployments on the promoted SHA, labels PRs `deployed:<stage>`, and starts `verify.yml`. |
| `verify.yml` | started by `promote.yml` | E2E (staging) and a Datadog watch run in parallel, plus an optional QA sign-off; posts `verified/<stage>` (and `verified/<stage>-proxy`). A failed production verification opens a `page` issue. |
| `stub-control.yml` | by hand | Demo knobs: raise or clear alarms, fail e2e, a build or a promotion, change the web dyno count. |

## Blockers (preflight)

| Blocker | Target |
| --- | --- |
| Source not deployed, or the two pipelines on different SHAs | both |
| `deployed/development` not green on the SHA | staging |
| `verified/staging` (and `-proxy`) not green on the SHA staging runs | production |
| SHA not on `main` | both |
| A deploy already in progress on a target app | both |
| A freeze in `.github/deploy-policy.json` | both |
| Proxy-only promotion past the schema the API app has applied | both |
| Outside Mon–Thu 14:00–17:00 ET (16:00 if a `*-risk` PR is in the range) | production |
| Fewer than 3 web dynos | production |
| `worker/` changed and `worker_order` empty | production |

`expedite: true` with a reason bypasses all of them. Target alarms are listed in the summary and
never block.

## Try it

```sh
# Development deploys itself after any merge to main. Then:
gh workflow run promote.yml -f target=staging
# wait for verify.yml to post verified/staging, then:
gh workflow run promote.yml -f target=production

# A production alarm doesn't block a hotfix:
gh workflow run stub-control.yml -f action=raise-alarm -f stage=production -f value="API 5xx rate"
# A failed staging e2e does block production:
gh workflow run stub-control.yml -f action=fail-e2e
```

Watch the commit page and **Deployments** (pinned environments) to follow a SHA through the stages.

## Settings

- Environments `staging` and `production`: deployment branch policy `main` only; they would hold
  the Heroku key. `staging-signoff`: a required reviewer, used when `REQUIRE_QA_SIGNOFF` is `true`.
- Repo variables: `WATCH_MINUTES` (the plan's value is 15; the demo uses 2), `REQUIRE_QA_SIGNOFF`.
- Stub state lives on the `stub-heroku` branch: `state/apps/<app>.json` and `state/control.json`.

## What the stub replaces

| Stub | Real call |
| --- | --- |
| `heroku.build` | `POST /apps/{app}/builds` with `source_blob.url` = the SHA's GitHub tarball link and `source_blob.version` = the SHA |
| `heroku.promote` | `POST /pipeline-promotions`, then poll `/pipeline-promotions/{id}/promotion-targets` |
| `heroku.getRelease` | the app's current release and its slug `commit` |
| `heroku.psWait` | `heroku ps:wait` |
| `control.alarms` | Datadog Monitors API, filtered by `env:<stage>` |
| `control.e2e_fail` | the real e2e suite against staging |
