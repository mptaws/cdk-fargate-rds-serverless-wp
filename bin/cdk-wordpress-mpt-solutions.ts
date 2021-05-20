#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkWordpressMptSolutionsStack } from '../lib/cdk-wordpress-mpt-solutions-stack';

const app = new cdk.App();
new CdkWordpressMptSolutionsStack(app, 'CdkWordpressMptSolutionsStack', {
  env: {
    account: "424156232756",
    region: 'us-east-1'
  }
});
