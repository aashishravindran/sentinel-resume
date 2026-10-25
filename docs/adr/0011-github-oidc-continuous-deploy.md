# 0011. Continuous deploy from master through GitHub OIDC

## Context

Every change to master should reach the live site once tests pass, without stored AWS keys and
without letting the pipeline grant itself more access.

## Decision

One workflow (`.github/workflows/ci.yml`):

1. **python** and **build** run on every push and pull request: lint, types, unit, workflow,
   trigger and red-team tests; frontend build, Lambda bundle, CDK tests and synth. The build job
   uploads the bundle and the SPA as artifacts.
2. **deploy** runs only for pushes to master, after both pass. It downloads the tested artifacts
   (no rebuild), assumes `sentinel-resume-github-deploy` through GitHub's OIDC provider, runs
   `cdk deploy SentinelResume --exclusively`, re-embeds the corpus, resets the demo accounts, and runs
   the live e2e (`scripts/e2e.py`) as a smoke test.

The role's trust policy accepts only `repo:aashishravindran/sentinel-resume:environment:production`,
and the `production` GitHub environment admits only the `master` branch. Deploys are serialized
(`concurrency: production`, no cancellation mid-deploy). The role lives in a separate stack
(`SentinelResumeCiCd`) deployed by hand; the pipeline deploys only `SentinelResume`.

## Consequences

- No long-lived AWS credentials anywhere; pull requests (including forks) can test but never deploy.
- The pipeline cannot change its own role: its stack is never deployed from CI, and the role has no
  `iam:` permissions of its own.
- It is still powerful: CDK deploys run through the bootstrap's CloudFormation execution role, which
  has `AdministratorAccess` by default. Whoever can push to master can change anything CloudFormation
  can. To narrow it, re-bootstrap with `--cloudformation-execution-policies` scoped to the services
  this stack uses (that affects every CDK app in the account and region).
- A failed CloudFormation deploy rolls back automatically. A failed post-deploy e2e does **not** roll
  back; it fails the run (GitHub emails the pusher). Recover by reverting the commit, which deploys
  the previous version.
- The e2e takes about three minutes (it waits for a one-minute grant to expire) and makes a few cents
  of Bedrock calls per deploy.
