#!/usr/bin/env node
// Copyright (c) 2026 Aashish Ravindran. All rights reserved.
// Use of this software is governed by the Elastic License 2.0
// found in the LICENSE file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { CiCdStack, assetsBucketName } from '../lib/cicd-stack';
import { ResumeStack } from '../lib/resume-stack';

const app = new App();
const root = path.join(__dirname, '..', '..');
const dist = path.join(root, 'frontend', 'dist');
const admins: { admins: string[] } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admins.json'), 'utf8'));

new ResumeStack(app, 'SentinelResume', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  // Deploy with the caller's credentials and this app's own asset bucket, not the CDK bootstrap roles
  // (their deploy role can update any stack in the account). CloudFormation runs as the scoped
  // execution role from SentinelResumeCiCd, passed with --role-arn.
  synthesizer: new CliCredentialsStackSynthesizer({ fileAssetsBucketName: assetsBucketName() }),
  lambdaBundlePath: path.join(root, 'build', 'lambda'),
  frontendDistPath: fs.existsSync(dist) ? dist : undefined,
  adminEmail: app.node.tryGetContext('adminEmail') ?? admins.admins[0],
  chatModelId: app.node.tryGetContext('chatModelId') ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
});

// Deployed by hand, once: `npx cdk deploy SentinelResumeCiCd`. The pipeline only deploys SentinelResume.
new CiCdStack(app, 'SentinelResumeCiCd', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  repository: 'aashishravindran/sentinel-resume',
  repositoryIds: { owner: 16415392, repo: 1433636947 },
  environment: 'production',
  existingOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
});
