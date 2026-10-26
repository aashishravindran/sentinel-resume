// Copyright (c) 2026 Aashish Ravindran. All rights reserved.
// Use of this software is governed by the Elastic License 2.0
// found in the LICENSE file.

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';
import { APP_TAG_KEY, APP_TAG_VALUE, BOUNDARY_POLICY_NAME } from './cicd-stack';
import { Monitoring } from './monitoring';

export interface ResumeStackProps extends StackProps {
  /** Python bundle from scripts/build_lambda.sh. */
  readonly lambdaBundlePath: string;
  /** Built SPA (frontend/dist). Omit to deploy only config.json, e.g. in tests. */
  readonly frontendDistPath?: string;
  /** Receives access-request emails and budget alerts; also the SES sender. */
  readonly adminEmail: string;
  /** Bedrock model or inference profile for answers. */
  readonly chatModelId: string;
  readonly monthlyBudgetUsd?: number;
}

const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const ADMIN_SUBS_PARAM = '/sentinel-resume/admin-subs';
const SIGNUPS_PER_DAY = 50;
// Matches Limits.global_chat_per_day in sentinel_resume/config.py.
const MODEL_CALLS_PER_DAY = 1500;

/** Recruiter-facing resume assistant: Cognito, HTTP API, Lambda, DynamoDB, S3 Vectors, CloudFront. */
export class ResumeStack extends Stack {
  constructor(scope: Construct, id: string, props: ResumeStackProps) {
    super(scope, id, props);
    // Created by SentinelResumeCiCd. The execution role refuses to create a role without it.
    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, 'Boundary', BOUNDARY_POLICY_NAME));

    // --- Data -------------------------------------------------------------------------------
    const table = (name: string, pk: string, ttl?: string) =>
      new dynamodb.TableV2(this, name, {
        partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: ttl,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const identityTable = table('Identity', 'user_id');
    const requestsTable = table('Requests', 'request_id');
    requestsTable.addGlobalSecondaryIndex({
      indexName: 'by_status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.NUMBER },
    });
    const rateLimitTable = table('RateLimit', 'pk', 'expires_at');
    const auditTable = table('Audit', 'pk', 'expires_at');
    auditTable.addGlobalSecondaryIndex({
      indexName: 'by_day',
      partitionKey: { name: 'day', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'at', type: dynamodb.AttributeType.NUMBER },
    });

    const vectorBucketName = `sentinel-resume-${this.account}`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'Vectors', { vectorBucketName });
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName,
      indexName: 'resume',
      dataType: 'float32',
      dimension: 1024,
      distanceMetric: 'cosine',
      // Chunk text and titles are returned, never filtered on; only tag_* keys are filterable.
      metadataConfiguration: { nonFilterableMetadataKeys: ['text', 'title', 'doc_id'] },
    });
    vectorIndex.addResourceDependency(vectorBucket);

    // --- Code -------------------------------------------------------------------------------
    const code = lambda.Code.fromAsset(props.lambdaBundlePath);
    const fn = (name: string, handler: string, opts: Partial<lambda.FunctionProps> = {}) =>
      new lambda.Function(this, name, {
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.ARM_64,
        code,
        handler,
        memorySize: 512,
        timeout: Duration.seconds(10),
        loggingFormat: lambda.LoggingFormat.JSON,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...opts,
      });

    // --- Cognito ----------------------------------------------------------------------------
    const preSignUp = fn('PreSignUp', 'sentinel_resume.triggers.pre_sign_up', {
      environment: { RATELIMIT_TABLE: rateLimitTable.tableName, SIGNUPS_PER_DAY: String(SIGNUPS_PER_DAY) },
    });
    const postConfirmation = fn('PostConfirmation', 'sentinel_resume.triggers.post_confirmation', {
      environment: { IDENTITY_TABLE: identityTable.tableName },
    });
    rateLimitTable.grant(preSignUp, 'dynamodb:UpdateItem');
    identityTable.grant(postConfirmation, 'dynamodb:PutItem');

    const userPool = new cognito.UserPool(this, 'Users', {
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Optional for recruiters; the API refuses admin calls from anyone without TOTP.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true },
      lambdaTriggers: { preSignUp, postConfirmation },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // The deploy role's Cognito admin calls (demo users, e2e) only work on a pool with this tag.
    Tags.of(userPool).add(APP_TAG_KEY, APP_TAG_VALUE);
    const client = userPool.addClient('Web', {
      authFlows: { userSrp: true, userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
    });
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'Managed by scripts/sync_admins.py from infra/admins.json. Do not edit by hand.',
    });

    // --- API --------------------------------------------------------------------------------
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    const environment = {
      SENTINEL_OIDC_ISSUER: issuer,
      SENTINEL_OIDC_JWKS_URI: `${issuer}/.well-known/jwks.json`,
      SENTINEL_OIDC_ALLOWED_CLIENTS: client.userPoolClientId,
      IDENTITY_TABLE: identityTable.tableName,
      REQUESTS_TABLE: requestsTable.tableName,
      RATELIMIT_TABLE: rateLimitTable.tableName,
      AUDIT_TABLE: auditTable.tableName,
      VECTOR_BUCKET: vectorBucketName,
      VECTOR_INDEX: 'resume',
      CHAT_MODEL_ID: props.chatModelId,
      EMBED_MODEL_ID: EMBED_MODEL_ID,
      ADMIN_SUBS_PARAM: ADMIN_SUBS_PARAM,
      ADMIN_EMAIL: props.adminEmail,
      FROM_EMAIL: props.adminEmail,
      REQUIRE_ADMIN_MFA: 'true',
    };
    const chatFn = fn('Chat', 'sentinel_resume.app.handler', {
      environment,
      timeout: Duration.seconds(29),
      reservedConcurrentExecutions: 5,
    });
    const apiFn = fn('Api', 'sentinel_resume.app.handler', {
      environment,
      reservedConcurrentExecutions: 3,
    });

    for (const f of [chatFn, apiFn]) {
      identityTable.grantReadWriteData(f);
      requestsTable.grantReadWriteData(f);
      rateLimitTable.grant(f, 'dynamodb:UpdateItem');
      auditTable.grantReadWriteData(f);
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: ADMIN_SUBS_PARAM.slice(1) })],
        }),
      );
      f.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [userPool.userPoolArn] }),
      );
    }
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
        resources: [vectorIndex.attrIndexArn],
      }),
    );
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: bedrockResources(this, [EMBED_MODEL_ID, props.chatModelId]) }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: props.adminEmail })],
      }),
    );
    new ses.EmailIdentity(this, 'AdminEmail', { identity: ses.Identity.email(props.adminEmail) });

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: new HttpJwtAuthorizer('Cognito', issuer, { jwtAudience: [client.userPoolClientId] }),
    });
    // Stage-wide throttle. Set on the L1: HttpStageOptions.throttle renders the API twice in 2.273.
    const stage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };
    const chatIntegration = new HttpLambdaIntegration('ChatIntegration', chatFn);
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    const { GET, POST } = apigwv2.HttpMethod;
    api.addRoutes({ path: '/api/chat', methods: [POST], integration: chatIntegration });
    for (const [path, method] of [
      ['/api/me', GET],
      ['/api/catalog', GET],
      ['/api/requests', GET],
      ['/api/requests', POST],
      ['/api/admin/overview', GET],
      ['/api/admin/requests/{id}/approve', POST],
      ['/api/admin/requests/{id}/deny', POST],
      ['/api/admin/grants/revoke', POST],
    ] as const) {
      api.addRoutes({ path, methods: [method], integration: apiIntegration });
    }

    // --- Site -------------------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        // Client-side routes (/chat, /admin, ...) all load index.html; files keep their path.
        "function handler(event) { var r = event.request; if (!r.uri.includes('.')) { r.uri = '/index.html'; } return r; }",
      ),
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(Fn.select(2, Fn.split('/', api.apiEndpoint))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'Deploy', {
      destinationBucket: siteBucket,
      distribution,
      sources: [
        ...(props.frontendDistPath ? [s3deploy.Source.asset(props.frontendDistPath)] : []),
        s3deploy.Source.jsonData('config.json', {
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: client.userPoolClientId,
        }),
      ],
    });

    // --- Cost guard -------------------------------------------------------------------------
    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: 'sentinel-resume',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd ?? 10, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.adminEmail }],
        },
      ],
    });

    // --- Monitoring -------------------------------------------------------------------------
    const monitoring = new Monitoring(this, 'Monitoring', {
      alertEmail: props.adminEmail,
      chatFn,
      apiFn,
      triggerFns: [preSignUp, postConfirmation],
      apiId: api.apiId,
      distributionId: distribution.distributionId,
      apiLogGroups: [chatFn.logGroup, apiFn.logGroup],
      chatsPerDayBudget: MODEL_CALLS_PER_DAY,
      signupsPerDay: SIGNUPS_PER_DAY,
    });

    new CfnOutput(this, 'AlertsTopicArn', { value: monitoring.topic.topicArn });
    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/SentinelResume`,
    });
    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'ApiEndpoint', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'IdentityTableName', { value: identityTable.tableName });
    new CfnOutput(this, 'VectorBucketName', { value: vectorBucketName });
    new CfnOutput(this, 'VectorIndexName', { value: 'resume' });
    new CfnOutput(this, 'AdminSubsParam', { value: ADMIN_SUBS_PARAM });
  }
}

/** InvokeModel targets: a cross-region inference profile also needs its foundation model in every region. */
function bedrockResources(stack: Stack, modelIds: string[]): string[] {
  return modelIds.flatMap((id) => {
    const match = /^(us|eu|apac|global)\.(.+)$/.exec(id);
    if (!match) return [`arn:aws:bedrock:${stack.region}::foundation-model/${id}`];
    return [
      stack.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: id }),
      `arn:aws:bedrock:*::foundation-model/${match[2]}`,
    ];
  });
}
