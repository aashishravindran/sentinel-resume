// Copyright (c) 2026 Aashish Ravindran. All rights reserved.
// Use of this software is governed by the Elastic License 2.0
// found in the LICENSE file.

import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

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
 * The role GitHub Actions assumes to deploy SentinelResume. No stored AWS keys.
 *
 * Deployed by hand, once, and never by the pipeline: the pipeline cannot widen
 * its own permissions.
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
    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'sentinel-resume-github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Only jobs that declare this environment; the environment only admits master.
          'token.actions.githubusercontent.com:sub': `repo:${owner}@${props.repositoryIds.owner}/${name}@${props.repositoryIds.repo}:environment:${props.environment}`,
        },
      }),
    });

    const account = this.account;
    const region = this.region;

    // cdk deploy: assume the bootstrap roles, which do the actual work.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'lookup'].map(
          (r) => `arn:aws:iam::${account}:role/cdk-hnb659fds-${r}-role-${account}-${region}`,
        ),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${region}:${account}:stack/SentinelResume/*`],
      }),
    );

    // scripts/ingest_corpus.py
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors'],
        resources: [`arn:aws:s3vectors:${region}:${account}:bucket/sentinel-resume-${account}/index/resume`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`],
      }),
    );

    // scripts/test_users.py and scripts/e2e.py: throwaway users, their identity items,
    // and a temporary allowlist entry for the e2e admin.
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
        resources: [`arn:aws:cognito-idp:${region}:${account}:userpool/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [`arn:aws:dynamodb:${region}:${account}:table/SentinelResume-Identity*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter/sentinel-resume/admin-subs`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
