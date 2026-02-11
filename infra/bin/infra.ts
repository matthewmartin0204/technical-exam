#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BomApiStack } from "../lib/bom-api-stack";

const app = new cdk.App();

// Get configuration from context or environment
const environment = app.node.tryGetContext("environment") || "dev";
const domainName = app.node.tryGetContext("domainName");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const account = process.env.CDK_DEFAULT_ACCOUNT || app.node.tryGetContext("account");
const region = process.env.CDK_DEFAULT_REGION || app.node.tryGetContext("region") || "ap-southeast-2";

// Validate required configuration
if (!account) {
  console.warn("Warning: AWS account not specified. Set CDK_DEFAULT_ACCOUNT or use -c account=...");
}

// Create the stack
new BomApiStack(app, `BomApiStack-${environment}`, {
  env: {
    account,
    region,
  },
  environment,
  domainName,
  hostedZoneName,
  description: `BOM Flood Warnings API - ${environment} environment`,
  tags: {
    Project: "BomFloodApi",
    Environment: environment,
    ManagedBy: "CDK",
  },
});

app.synth();
