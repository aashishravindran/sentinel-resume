// Copyright (c) 2026 Aashish Ravindran. All rights reserved.
// Use of this software is governed by the Elastic License 2.0
// found in the LICENSE file.

import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/** Metric names written by sentinel_resume/metrics.py. */
const NAMESPACE = 'SentinelResume';
const DIMENSIONS = { Service: 'resume' };

export interface MonitoringProps {
  readonly alertEmail: string;
  readonly chatFn: lambda.IFunction;
  readonly apiFn: lambda.IFunction;
  readonly triggerFns: lambda.IFunction[];
  readonly apiId: string;
  readonly distributionId: string;
  /** Log groups with the per-request and per-question lines, for the dashboard's log tables. */
  readonly apiLogGroups: logs.ILogGroup[];
  readonly chatsPerDayBudget: number;
  readonly signupsPerDay: number;
}

/** Alarms that email the admin, and one dashboard for traffic, answers, abuse and health. */
export class Monitoring extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'Alerts', { displayName: 'Sentinel resume alerts' });
    this.topic.addSubscription(new subs.EmailSubscription(props.alertEmail));

    const app = (name: string, statistic = 'Sum', period = Duration.minutes(5)) =>
      new cloudwatch.Metric({ namespace: NAMESPACE, metricName: name, dimensionsMap: DIMENSIONS, statistic, period });

    const alarm = (
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      evaluationPeriods = 1,
    ) => {
      const a = new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(new actions.SnsAction(this.topic));
      return a;
    };

    // --- Security ---------------------------------------------------------------------------
    alarm(
      'PostcheckDropped',
      app('PostcheckDropped'),
      1,
      'The re-check removed a chunk the vector filter returned: the store ignored the filter. Investigate now.',
    );
    alarm(
      'AdminProbing',
      app('AdminDenied', 'Sum', Duration.minutes(15)),
      3,
      'Three or more refused admin calls in 15 minutes (each deploy makes one on purpose).',
    );
    alarm(
      'RateLimited',
      app('RateLimited', 'Sum', Duration.minutes(15)),
      30,
      'Thirty or more 429s in 15 minutes: someone is hammering the API.',
    );

    // --- Cost and capacity ------------------------------------------------------------------
    alarm(
      'ModelBudget',
      app('ModelCalls', 'Sum', Duration.days(1)),
      Math.floor(props.chatsPerDayBudget * 0.8),
      `80% of the daily model budget (${props.chatsPerDayBudget} calls) used today.`,
    );
    alarm('BudgetExhausted', app('BudgetExhausted'), 1, 'The daily model budget is spent; chat is resting until 00:00 UTC.');
    alarm(
      'SignupsNearCap',
      app('SignUps', 'Sum', Duration.days(1)),
      Math.floor(props.signupsPerDay * 0.8),
      `80% of the daily sign-up cap (${props.signupsPerDay}) used today.`,
    );
    alarm('SignupsBlocked', app('SignUpsBlocked'), 1, 'The daily sign-up cap was hit; new recruiters are being turned away.');
    alarm(
      'ChatThrottled',
      props.chatFn.metricThrottles({ period: Duration.minutes(5) }),
      5,
      'Chat is at its concurrency limit (5): traffic spike. Consider raising reserved concurrency.',
    );

    // --- Health -------------------------------------------------------------------------------
    alarm('InternalErrors', app('InternalErrors'), 3, 'Three or more 500s from the API in 5 minutes.');
    for (const [name, fn] of [['Chat', props.chatFn], ['Api', props.apiFn]] as const) {
      alarm(`${name}Errors`, fn.metricErrors({ period: Duration.minutes(5) }), 3, `${name} Lambda crashed 3+ times in 5 minutes.`);
    }
    alarm(
      'ChatSlow',
      app('ChatLatencyMs', 'p90', Duration.minutes(15)),
      15000,
      'p90 chat latency over 15 s for 30 minutes (the API times out at 29 s).',
      2,
    );

    // --- Activity worth knowing about --------------------------------------------------------
    alarm('AccessRequest', app('AccessRequests'), 1, 'A recruiter asked for a restricted document. Review it on /admin.');

    // --- Dashboard ----------------------------------------------------------------------------
    const hourly = (name: string, label: string) => app(name, 'Sum', Duration.hours(1)).with({ label });
    const cf = (metricName: string, statistic = 'Sum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        dimensionsMap: { DistributionId: props.distributionId, Region: 'Global' },
        statistic,
        period: Duration.hours(1),
        region: 'us-east-1',
      });
    const api = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: { ApiId: props.apiId },
        statistic: 'Sum',
        period: Duration.hours(1),
      });
    const query = (title: string, lines: string[]) =>
      new cloudwatch.LogQueryWidget({
        title,
        logGroupNames: props.apiLogGroups.map((g) => g.logGroupName),
        queryLines: lines,
        width: 24,
        height: 7,
        view: cloudwatch.LogQueryVisualizationType.TABLE,
      });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'SentinelResume',
      defaultInterval: Duration.days(7),
      widgets: [
        [
          new cloudwatch.SingleValueWidget({
            title: 'Last 24 hours',
            width: 24,
            height: 4,
            setPeriodToTimeRange: true,
            metrics: [
              app('Questions').with({ label: 'Questions' }),
              app('Answered').with({ label: 'Answered' }),
              app('SignUps').with({ label: 'Sign-ups' }),
              app('AccessRequests').with({ label: 'Access requests' }),
              app('PostcheckDropped').with({ label: 'Filter bypasses (must be 0)' }),
              cf('Requests').with({ label: 'Page and API requests' }),
            ],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Traffic (per hour)',
            width: 12,
            left: [cf('Requests').with({ label: 'CloudFront requests' }), api('Count').with({ label: 'API calls' })],
          }),
          new cloudwatch.GraphWidget({
            title: 'Questions (per hour)',
            width: 12,
            left: [
              hourly('Questions', 'Asked'),
              hourly('Answered', 'Answered'),
              hourly('ModelCalls', 'Model calls'),
            ],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Recruiters (per hour)',
            width: 12,
            left: [hourly('SignUps', 'Sign-ups'), hourly('AccessRequests', 'Access requests')],
            right: [hourly('SignUpsBlocked', 'Sign-ups blocked by the cap')],
          }),
          new cloudwatch.GraphWidget({
            title: 'Abuse signals (per hour)',
            width: 12,
            left: [
              hourly('RateLimited', '429 rate limited'),
              hourly('AdminDenied', 'Admin refused'),
              hourly('PostcheckDropped', 'Filter bypasses'),
            ],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Chat latency',
            width: 12,
            left: [
              app('ChatLatencyMs', 'p50', Duration.hours(1)).with({ label: 'p50 ms' }),
              app('ChatLatencyMs', 'p90', Duration.hours(1)).with({ label: 'p90 ms' }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title: 'Errors and throttles',
            width: 12,
            left: [
              api('5xx').with({ label: 'API 5xx' }),
              api('4xx').with({ label: 'API 4xx' }),
              props.chatFn.metricErrors({ period: Duration.hours(1), label: 'Chat errors' }),
              props.apiFn.metricErrors({ period: Duration.hours(1), label: 'API errors' }),
              props.chatFn.metricThrottles({ period: Duration.hours(1), label: 'Chat throttles' }),
              ...props.triggerFns.map((f, i) => f.metricErrors({ period: Duration.hours(1), label: `Trigger ${i + 1} errors` })),
            ],
          }),
        ],
        [
          query('Latest questions', [
            'fields @timestamp, chat.outcome as outcome, chat.question as question, chat.latency_ms as ms, chat.user as user',
            'filter ispresent(chat.question)',
            'sort @timestamp desc',
            'limit 50',
          ]),
        ],
        [
          query('Latest API calls', [
            'fields @timestamp, request.status as status, request.route as route, request.ip as ip, request.latency_ms as ms, request.user as user',
            'filter ispresent(request.route)',
            'sort @timestamp desc',
            'limit 50',
          ]),
        ],
      ],
    });
  }
}
