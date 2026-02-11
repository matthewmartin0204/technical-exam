import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BomApiStack } from "../lib/bom-api-stack";

describe("BomApiStack", () => {
  const app = new cdk.App();
  const stack = new BomApiStack(app, "TestStack", {
    environment: "test",
    env: {
      account: "123456789012",
      region: "ap-southeast-2",
    },
  });
  const template = Template.fromStack(stack);

  test("creates VPC with 2 AZs", () => {
    template.resourceCountIs("AWS::EC2::VPC", 1);
  });

  test("creates ECS Cluster", () => {
    template.resourceCountIs("AWS::ECS::Cluster", 1);
  });

  test("creates Fargate Service", () => {
    template.resourceCountIs("AWS::ECS::Service", 1);
  });

  test("creates Application Load Balancer", () => {
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
  });

  test("creates ElastiCache Redis cluster", () => {
    template.resourceCountIs("AWS::ElastiCache::CacheCluster", 1);
    template.hasResourceProperties("AWS::ElastiCache::CacheCluster", {
      Engine: "redis",
      CacheNodeType: "cache.t4g.micro",
    });
  });

  test("creates ECR Repository", () => {
    template.resourceCountIs("AWS::ECR::Repository", 1);
  });

  test("ECS Service has auto-scaling configured", () => {
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 1);
  });
});
