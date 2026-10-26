// Copyright (c) 2026 Aashish Ravindran. All rights reserved.
// Use of this software is governed by the Elastic License 2.0
// found in the LICENSE file.

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/** Every role SentinelResume creates carries this boundary; the execution role can't create one without it. */
export const BOUNDARY_POLICY_NAME = 'sentinel-resume-boundary';
/** Tag on the user pool; the deploy role's Cognito admin calls only work on pools carrying it. */
export const APP_TAG_KEY = 'app';
export const APP_TAG_VALUE = 'sentinel-resume';

/** Asset bucket for SentinelResume deploys; the synthesizer resolves the placeholders. */
export function assetsBucketName(account = '${AWS::AccountId}', region = '${AWS::Region}'): string {
  return `sentinel-resume-assets-${account}-${region}`;
}

export interface CiCdStackProps extends StackProps {
  /** owner/name of the GitHub repository allowed to deploy. */
  readonly repository: string;
  /**
   * GitHub's immutable IDs for the owner and repository. GitHub puts them in the token subject
   * (`repo:owner@<id>/name@<id>:...`), so a deleted-and-recreated repo cannot assume the role.
   */
  readonly repositoryIds: { readonly owner: number; readonly repo: number };
  /** GitHub environment the deploy job runs in; only it can assume the role. */
  readonly environment: string;
  /** Pass an existing provider ARN if the account already trusts GitHub's OIDC issuer. */
  readonly existingOidcProviderArn?: string;
}

/**
 * What GitHub Actions may do to this AWS account. No stored AWS keys.
 *
 * - DeployRole: assumed through GitHub OIDC; deploys only the SentinelResume stack and runs the scripts.
 * - ExecutionRole: CloudFormation's role for that stack, scoped to the services it uses.
 * - Boundary: caps every role the stack creates, so a template can't mint an admin role.
 *
 * Deployed by hand, never by the pipeline: the pipeline cannot widen its own permissions.
 */
export class CiCdStack extends Stack {
  constructor(scope: Construct, id: string, props: CiCdStackProps) {
    super(scope, id, props);

    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const [owner, name] = props.repository.split('/');
    const account = this.account;
    const region = this.region;
    const arn = (service: string, resource: string, r = region) => `arn:aws:${service}:${r}:${account}:${resource}`;

    // --- Assets: a bucket only this app uses (not the account-wide CDK bootstrap bucket) ---------
    const assets = new s3.Bucket(this, 'Assets', {
      bucketName: assetsBucketName(account, region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Boundary: the most any role created by SentinelResume can ever do ------------------------
    const appLogGroups = [arn('logs', 'log-group:SentinelResume-*'), arn('logs', 'log-group:/aws/lambda/SentinelResume-*')];
    const appTables = [arn('dynamodb', 'table/SentinelResume-*')];
    const appBuckets = ['arn:aws:s3:::sentinelresume-*'];
    const boundary = new iam.ManagedPolicy(this, 'Boundary', {
      managedPolicyName: BOUNDARY_POLICY_NAME,
      description: 'Permissions boundary for every role the SentinelResume stack creates.',
      statements: [
        new iam.PolicyStatement({
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: appLogGroups.flatMap((g) => [g, `${g}:*`]),
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan',
            'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem',
            'dynamodb:ConditionCheckItem', 'dynamodb:DescribeTable'],
          resources: appTables.flatMap((t) => [t, `${t}/index/*`]),
        }),
        new iam.PolicyStatement({
          actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
          resources: [arn('s3vectors', `bucket/sentinel-resume-${account}/index/*`)],
        }),
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: ['arn:aws:bedrock:*::foundation-model/*', arn('bedrock', 'inference-profile/*')],
        }),
        new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [arn('ssm', 'parameter/sentinel-resume/*')] }),
        new iam.PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [arn('cognito-idp', 'userpool/*')] }),
        new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: [arn('ses', 'identity/*')] }),
        // BucketDeployment and auto-delete: the site bucket, plus reading uploaded assets.
        new iam.PolicyStatement({ actions: ['s3:*'], resources: appBuckets.flatMap((b) => [b, `${b}/*`]) }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetBucketLocation', 's3:ListBucket'],
          resources: [assets.bucketArn, assets.arnForObjects('*')],
        }),
        new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], resources: ['*'] }),
      ],
    });

    // --- CloudFormation execution role: what a SentinelResume deploy may touch --------------------
    const execution = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'CloudFormation runs SentinelResume deploys as this role. Not assumable by anyone else.',
    });
    const allow = (actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      execution.addToPolicy(new iam.PolicyStatement({ actions, resources, conditions }));
    const appRoles = `arn:aws:iam::${account}:role/SentinelResume-*`;
    const bounded = { StringEquals: { 'iam:PermissionsBoundary': boundary.managedPolicyArn } };
    // Roles: only SentinelResume-* names, only with the boundary, only the Lambda basic policy attached.
    allow(['iam:CreateRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:PutRolePermissionsBoundary'], [appRoles], bounded);
    allow(['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], [appRoles], {
      ...bounded,
      ArnEquals: { 'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
    });
    allow(['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:DeleteRole',
      'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy'], [appRoles]);
    allow(['iam:PassRole'], [appRoles], { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } });
    allow(['dynamodb:*'], appTables.flatMap((t) => [t, `${t}/*`]));
    allow(['dynamodb:DescribeLimits', 'dynamodb:ListTables'], ['*']);
    allow(['lambda:*'], [arn('lambda', 'function:SentinelResume-*'), arn('lambda', 'layer:*')]);
    allow(['lambda:GetLayerVersion', 'lambda:ListTags'], ['*']);
    allow(['logs:*'], appLogGroups.flatMap((g) => [g, `${g}:*`]));
    allow(['logs:DescribeLogGroups'], ['*']);
    allow(['s3:*'], appBuckets.flatMap((b) => [b, `${b}/*`]));
    allow(['s3:GetObject'], [assets.arnForObjects('*')]);
    allow(['s3vectors:*'], [arn('s3vectors', `bucket/sentinel-resume-${account}`), arn('s3vectors', `bucket/sentinel-resume-${account}/*`)]);
    allow(['cognito-idp:*'], [arn('cognito-idp', 'userpool/*')]);
    allow(['cognito-idp:CreateUserPool', 'cognito-idp:ListUserPools'], ['*']);
    allow(['apigateway:*'], [`arn:aws:apigateway:${region}::/*`]);
    allow(['cloudfront:*'], ['*']);
    allow(['ses:*'], [arn('ses', 'identity/*')]);
    allow(['budgets:*'], [`arn:aws:budgets::${account}:budget/sentinel-resume`]);
    // Monitoring: alarms, the dashboard and the alerts topic (names start with the stack name).
    allow(['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms',
      'cloudwatch:TagResource', 'cloudwatch:UntagResource', 'cloudwatch:ListTagsForResource'],
    [arn('cloudwatch', 'alarm:SentinelResume-*')]);
    allow(['cloudwatch:PutDashboard', 'cloudwatch:DeleteDashboards', 'cloudwatch:GetDashboard'],
      [`arn:aws:cloudwatch::${account}:dashboard/SentinelResume`]);
    allow(['sns:*'], [arn('sns', 'SentinelResume-*')]);
    allow(['sns:Unsubscribe', 'sns:GetSubscriptionAttributes', 'sns:SetSubscriptionAttributes'], ['*']);

    // --- GitHub deploy role: deploy one stack, nothing else ----------------------------------------
    const role = new iam.Role(this, 'DeployRole', {
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Only jobs that declare this environment; the environment only admits master.
          'token.actions.githubusercontent.com:sub': `repo:${owner}@${props.repositoryIds.owner}/${name}@${props.repositoryIds.repo}:environment:${props.environment}`,
        },
      }),
    });

    // cdk deploy with CLI credentials: change sets on SentinelResume only, run as the execution role.
    // No access to the CDK bootstrap roles, which could update any other stack as AdministratorAccess.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet',
          'cloudformation:DeleteChangeSet', 'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources', 'cloudformation:ListStackResources', 'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary'],
        resources: [arn('cloudformation', 'stack/SentinelResume/*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [execution.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
      }),
    );
    assets.grantReadWrite(role);

    // scripts/ingest_corpus.py (ListVectors: prune documents that were removed)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:ListVectors'],
        resources: [arn('s3vectors', `bucket/sentinel-resume-${account}/index/resume`)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`],
      }),
    );

    // scripts/test_users.py and scripts/e2e.py: throwaway users, their identity items,
    // and a temporary allowlist entry for the e2e admin. Only the pool tagged as this app's.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:AdminAddUserToGroup',
        ],
        resources: [arn('cognito-idp', 'userpool/*')],
        conditions: { StringEquals: { [`aws:ResourceTag/${APP_TAG_KEY}`]: APP_TAG_VALUE } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [arn('dynamodb', 'table/SentinelResume-Identity*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [arn('ssm', 'parameter/sentinel-resume/admin-subs')],
      }),
    );

    // Not printed by CI: store both as GitHub environment secrets.
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
    new CfnOutput(this, 'ExecutionRoleArn', { value: execution.roleArn });
  }
}
