# 0012. Scoped deploy roles instead of the CDK bootstrap roles

## Context

ADR 0011 had the GitHub role assume the CDK bootstrap roles. Two problems:

- The bootstrap CloudFormation execution role has `AdministratorAccess`, so a malicious commit on
  master (or a compromised action or dependency in the deploy job) could do anything in the account,
  for example create an admin IAM role inside the template.
- The bootstrap deploy role can create change sets on **any** stack. An updated stack keeps its
  previous service role, so it could update other CDK stacks in the account as administrator.

The public Actions logs also printed the role ARN and account ID, and the role had a fixed name.
ARNs aren't credentials (the trust policy is what protects the role), but there is no reason to
publish them.

## Decision

`SentinelResumeCiCd` (deployed by hand, never by CI) creates three things, and the app stack uses
`CliCredentialsStackSynthesizer` so the bootstrap roles are never involved:

1. **Deploy role** (GitHub OIDC, `production` environment on master, pinned to repo IDs):
   - CloudFormation change-set actions on `stack/SentinelResume/*` only.
   - `iam:PassRole` on the execution role, only to `cloudformation.amazonaws.com`.
   - Read/write on its own asset bucket `sentinel-resume-assets-<account>-<region>`, not the
     account-wide bootstrap bucket.
   - The script calls: put/delete vectors on the one index, Titan embeddings, the identity table,
     the admin-subs parameter, and Cognito admin calls on pools tagged `app=sentinel-resume`.
2. **Execution role** (trusted only by CloudFormation): each service the stack uses, scoped to
   `SentinelResume-*` / `sentinelresume-*` names where the service names resources from the stack.
   IAM is limited to roles named `SentinelResume-*`, and creating a role, adding a policy to one or
   setting its boundary all require `iam:PermissionsBoundary` = the boundary policy. Removing a
   boundary isn't allowed, and the only managed policy it can attach is Lambda basic execution.
3. **Permissions boundary** `sentinel-resume-boundary`, applied to every role in the app stack with
   `PermissionsBoundary.of(stack)`: the app's tables, vector index, Bedrock, its SSM parameter, SES,
   its buckets, log groups and CloudFront invalidations. Whatever a template attaches to a Lambda
   role, the Lambda can't exceed this.

In the workflow, role ARNs are environment secrets, `mask-aws-account-id` is on, actions are pinned to
commit SHAs, dependencies are installed before credentials are configured, and the session lasts 30
minutes.

## Consequences

- A malicious master commit can break or rewrite this app, but cannot create an unbounded role, touch
  other stacks, or reach data outside the app's resources.
- Cognito user pools, HTTP APIs and CloudFront distributions have generated IDs, so the execution role
  allows those services account-wide. CloudFormation only acts on resources in its own template, but
  a template could add new ones of those types.
- Adding a new AWS service to the app means widening the execution role and the boundary in
  `infra/lib/cicd-stack.ts` and redeploying `SentinelResumeCiCd` by hand. That's intentional: the
  pipeline cannot widen itself.
- Local deploys pass `--role-arn <ExecutionRoleArn>` (or CloudFormation reuses the stack's stored role).
- Old public workflow runs that printed the previous role ARN and account ID were deleted.
