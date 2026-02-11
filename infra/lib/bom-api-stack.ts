import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface BomApiStackProps extends cdk.StackProps {
  /**
   * The domain name for the API (e.g., "api.example.com")
   * Set to undefined to skip Route53/ACM setup
   */
  domainName?: string;

  /**
   * The Route53 hosted zone name (e.g., "example.com")
   */
  hostedZoneName?: string;

  /**
   * Environment name (e.g., "dev", "staging", "prod")
   */
  environment: string;
}

export class BomApiStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: BomApiStackProps) {
    super(scope, id, props);

    const { environment, domainName, hostedZoneName } = props;

    // ============================================================
    // VPC - Network foundation
    // ============================================================
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2, // Use 2 availability zones for high availability
      natGateways: 1, // Single NAT gateway to reduce costs
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ============================================================
    // Security Groups
    // ============================================================

    // ALB Security Group - allows inbound HTTP/HTTPS from internet
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP"
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS"
    );

    // ECS Tasks Security Group - allows inbound from ALB only
    const ecsSecurityGroup = new ec2.SecurityGroup(this, "EcsSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for ECS Fargate tasks",
      allowAllOutbound: true, // Needed for FTP to BOM
    });
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      "Allow traffic from ALB"
    );

    // Redis Security Group - allows inbound from ECS only
    const redisSecurityGroup = new ec2.SecurityGroup(
      this,
      "RedisSecurityGroup",
      {
        vpc: this.vpc,
        description: "Security group for ElastiCache Redis",
        allowAllOutbound: false,
      }
    );
    redisSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(6379),
      "Allow Redis from ECS tasks"
    );

    // ============================================================
    // ElastiCache Redis - Single node for caching
    // ============================================================

    // Subnet group for Redis (private subnets)
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: "Subnet group for BOM API Redis cache",
        subnetIds: this.vpc.privateSubnets.map((subnet) => subnet.subnetId),
        cacheSubnetGroupName: `bom-api-redis-${environment}`,
      }
    );

    // Redis cluster (single node)
    const redisCluster = new elasticache.CfnCacheCluster(this, "RedisCluster", {
      clusterName: `bom-api-cache-${environment}`,
      engine: "redis",
      engineVersion: "7.1",
      cacheNodeType: "cache.t4g.micro", // Smallest, ~$12/month
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      port: 6379,
    });
    redisCluster.addDependency(redisSubnetGroup);

    // Store Redis URL in Secrets Manager
    const redisSecret = new secretsmanager.Secret(this, "RedisSecret", {
      secretName: `bom-api/${environment}/redis-url`,
      description: "Redis connection URL for BOM API",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        `redis://${redisCluster.attrRedisEndpointAddress}:${redisCluster.attrRedisEndpointPort}`
      ),
    });

    // ============================================================
    // ECR Repository - Container image storage
    // ============================================================
    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: `bom-flood-api-${environment}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10, // Keep only last 10 images
          rulePriority: 1,
          description: "Keep only 10 images",
        },
      ],
    });

    // ============================================================
    // ECS Cluster
    // ============================================================
    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: this.vpc,
      clusterName: `bom-api-${environment}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ============================================================
    // CloudWatch Log Group
    // ============================================================
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/ecs/bom-api-${environment}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================
    // ECS Task Definition
    // ============================================================
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        memoryLimitMiB: 512,
        cpu: 256,
        family: `bom-api-${environment}`,
      }
    );

    // Add container to task definition
    const container = taskDefinition.addContainer("api", {
      // Initially use a placeholder image - will be replaced by CI/CD
      image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      containerName: "bom-api",
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "bom-api",
        logGroup,
      }),
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        LOG_LEVEL: "info",
        FTP_HOST: "ftp.bom.gov.au",
        FTP_PATH: "/anon/gen/fwo/",
        FTP_POOL_MIN: "2",
        FTP_POOL_MAX: "5", // Lower per-task to avoid overwhelming BOM FTP
      },
      secrets: {
        REDIS_URL: ecs.Secret.fromSecretsManager(redisSecret),
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -f http://localhost:3000/health || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // ============================================================
    // Application Load Balancer
    // ============================================================
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      loadBalancerName: `bom-api-${environment}`,
    });

    // ============================================================
    // Route53 & ACM Certificate (optional)
    // ============================================================
    let certificate: acm.ICertificate | undefined;
    let hostedZone: route53.IHostedZone | undefined;

    if (domainName && hostedZoneName) {
      // Look up existing hosted zone
      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: hostedZoneName,
      });

      // Create SSL certificate
      certificate = new acm.Certificate(this, "Certificate", {
        domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      // Create DNS record pointing to ALB
      new route53.ARecord(this, "DnsRecord", {
        zone: hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(this.loadBalancer)
        ),
      });
    }

    // ============================================================
    // ALB Listeners
    // ============================================================

    // HTTPS listener (if certificate exists)
    let httpsListener: elbv2.ApplicationListener | undefined;
    if (certificate) {
      httpsListener = this.loadBalancer.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
      });

      // HTTP listener redirects to HTTPS
      this.loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      // HTTP only (for development without domain)
      httpsListener = this.loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });
    }

    // ============================================================
    // ECS Fargate Service
    // ============================================================
    this.service = new ecs.FargateService(this, "Service", {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 2, // Start with 2 for high availability
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      serviceName: `bom-api-${environment}`,
      enableExecuteCommand: true, // Allows debugging via ECS Exec
      circuitBreaker: {
        rollback: true, // Rollback on deployment failure
      },
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      minHealthyPercent: 100, // Keep all tasks running during deployment
      maxHealthyPercent: 200, // Allow double capacity during deployment
    });

    // Register service with ALB target group
    const targetGroup = httpsListener.addTargets("EcsTargets", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: "200",
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ============================================================
    // Auto Scaling
    // ============================================================
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 20,
    });

    // Scale based on CPU utilization
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Scale based on request count
    scaling.scaleOnRequestCount("RequestScaling", {
      requestsPerTarget: 1000,
      targetGroup,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ============================================================
    // Outputs
    // ============================================================
    new cdk.CfnOutput(this, "LoadBalancerDns", {
      value: this.loadBalancer.loadBalancerDnsName,
      description: "Load Balancer DNS name",
      exportName: `BomApi-${environment}-AlbDns`,
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
      description: "ECR Repository URI for pushing images",
      exportName: `BomApi-${environment}-EcrUri`,
    });

    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
      description: "ECS Cluster name",
      exportName: `BomApi-${environment}-ClusterName`,
    });

    new cdk.CfnOutput(this, "ServiceName", {
      value: this.service.serviceName,
      description: "ECS Service name",
      exportName: `BomApi-${environment}-ServiceName`,
    });

    if (domainName) {
      new cdk.CfnOutput(this, "ApiUrl", {
        value: `https://${domainName}`,
        description: "API URL",
        exportName: `BomApi-${environment}-ApiUrl`,
      });
    }

    new cdk.CfnOutput(this, "RedisEndpoint", {
      value: `${redisCluster.attrRedisEndpointAddress}:${redisCluster.attrRedisEndpointPort}`,
      description: "Redis endpoint",
      exportName: `BomApi-${environment}-RedisEndpoint`,
    });
  }
}
