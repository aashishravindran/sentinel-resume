import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CiCdStack } from '../lib/cicd-stack';
import { ResumeStack } from '../lib/resume-stack';

function synth(chatModelId = 'us.amazon.nova-lite-v1:0'): Template {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  fs.writeFileSync(path.join(bundle, 'index.py'), '');
  const app = new App();
  const stack = new ResumeStack(app, 'Test', {
    env: { account: '123456789012', region: 'us-east-1' },
    lambdaBundlePath: bundle,
    adminEmail: 'admin@example.com',
    chatModelId,
  });
  return Template.fromStack(stack);
}

describe('ResumeStack', () => {
  const t = synth();

  test('every API route requires a Cognito JWT', () => {
    const routes = t.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes)).toHaveLength(9);
    for (const route of Object.values(routes)) {
      expect(route.Properties.AuthorizationType).toBe('JWT');
    }
  });

  test('stage is throttled', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
  });

  test('chat and api functions have reserved concurrency', () => {
    const limits = Object.values(t.findResources('AWS::Lambda::Function'))
      .map((f) => f.Properties.ReservedConcurrentExecutions)
      .filter((v) => v !== undefined)
      .sort();
    expect(limits).toEqual([3, 5]);
  });

  test('self sign-up with email verification and TOTP available', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: ['email'],
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
  });

  test('only filter on tags: chunk text is non-filterable', () => {
    t.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: { NonFilterableMetadataKeys: Match.arrayWith(['text']) },
    });
  });

  test('only the chat function can query vectors or call Bedrock', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy'));
    const withAction = (action: string) =>
      policies.filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes(action));
    expect(withAction('s3vectors:QueryVectors')).toHaveLength(1);
    expect(withAction('bedrock:InvokeModel')).toHaveLength(1);
  });

  test('every role carries the sentinel-resume permissions boundary', () => {
    const roles = Object.values(t.findResources('AWS::IAM::Role'));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(':policy/sentinel-resume-boundary');
    }
  });

  test('the user pool is tagged for the deploy role', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTags: { app: 'sentinel-resume' } });
  });

  test('budget alarm exists', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' } }),
    });
  });
});

describe('CiCdStack', () => {
  const app = new App();
  const t = Template.fromStack(
    new CiCdStack(app, 'CiCd', {
      env: { account: '123456789012', region: 'us-east-1' },
      repository: 'owner/repo',
      repositoryIds: { owner: 1, repo: 2 },
      environment: 'production',
    }),
  );

  test('only the production environment of the repo can assume the deploy role', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:owner@1/repo@2:environment:production',
              },
            },
          }),
        ],
      },
    });
  });

  const policyOf = (logicalPrefix: string) => {
    const [doc] = Object.entries(t.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith(logicalPrefix))
      .map(([, p]) => p.Properties.PolicyDocument.Statement as { Action: string | string[]; Condition?: unknown }[]);
    return doc.map((st) => ({ actions: ([] as string[]).concat(st.Action), condition: st.Condition }));
  };

  test('the deploy role cannot assume the CDK bootstrap roles or touch IAM beyond passing one role', () => {
    const statements = policyOf('DeployRole');
    const actions = statements.flatMap((st) => st.actions);
    expect(actions).not.toContain('sts:AssumeRole');
    expect(actions.filter((a) => a.startsWith('iam:'))).toEqual(['iam:PassRole']);
    const pass = statements.find((st) => st.actions.includes('iam:PassRole'))!;
    expect(pass.condition).toEqual({ StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } });
  });

  test('the deploy role changes only the SentinelResume stack', () => {
    const doc = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(doc).toContain(':stack/SentinelResume/*');
    expect(doc).not.toMatch(/"cloudformation:\*"/);
  });

  test('the execution role can only create roles that carry the boundary', () => {
    const statements = policyOf('ExecutionRole');
    for (const st of statements.filter((s) =>
      s.actions.some((a) => ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:PutRolePermissionsBoundary'].includes(a)))) {
      expect(JSON.stringify(st.condition)).toContain('iam:PermissionsBoundary');
    }
    const actions = statements.flatMap((st) => st.actions);
    expect(actions).not.toContain('iam:*');
    expect(actions).not.toContain('iam:DeleteRolePermissionsBoundary');
    expect(actions).not.toContain('*');
  });

  test('no role has a fixed, guessable name', () => {
    for (const role of Object.values(t.findResources('AWS::IAM::Role'))) {
      expect(role.Properties.RoleName).toBeUndefined();
    }
  });
});
