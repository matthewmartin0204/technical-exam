# BOM Flood API - Infrastructure

This directory contains the AWS CDK infrastructure for deploying the BOM Flood Warnings API.

## Architecture

```
                    ┌─────────────────┐
                    │   Route 53      │
                    │   (Optional)    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Application    │
                    │  Load Balancer  │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼───────┐
│  Fargate      │   │  Fargate      │   │  Fargate      │
│  Task 1       │   │  Task 2       │   │  Task N       │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  ElastiCache    │
                    │  (Redis)        │
                    └─────────────────┘
```

## Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Node.js 22+** 
3. **AWS CDK CLI** installed globally:
   ```bash
   npm install -g aws-cdk
   ```

## Setup

```bash
cd infra
npm install
```

## Configuration

The stack accepts the following context parameters:

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `environment` | No | `dev` | Environment name (dev, staging, prod) |
| `domainName` | No | - | Custom domain (e.g., `api.example.com`) |
| `hostedZoneName` | No | - | Route53 hosted zone (e.g., `example.com`) |
| `account` | No | From AWS CLI | AWS account ID |
| `region` | No | `ap-southeast-2` | AWS region |

## Deployment

### Development (No Custom Domain)

```bash
# Bootstrap CDK (first time only)
cdk bootstrap

# Deploy development environment
cdk deploy BomApiStack-dev
```

### Production (With Custom Domain)

```bash
# Deploy production with custom domain
cdk deploy BomApiStack-prod \
  -c environment=prod \
  -c domainName=api.yourcompany.com \
  -c hostedZoneName=yourcompany.com
```

### Staging

```bash
cdk deploy BomApiStack-staging -c environment=staging
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `cdk synth` | Synthesize CloudFormation template |
| `cdk diff` | Compare deployed stack with current state |
| `cdk deploy` | Deploy the stack |
| `cdk destroy` | Destroy the stack |
| `cdk watch` | Watch for changes and deploy automatically |

## After Deployment

1. **Get the ALB DNS name** from the stack outputs
2. **Push your Docker image** to ECR:
   ```bash
   # Get ECR login
   aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-southeast-2.amazonaws.com
   
   # Build and push
   docker build -t bom-flood-api ..
   docker tag bom-flood-api:latest <ecr-uri>:latest
   docker push <ecr-uri>:latest
   
   # Force new deployment
   aws ecs update-service --cluster bom-api-dev --service bom-api-dev --force-new-deployment
   ```

## Estimated Costs

| Resource | Spec | Monthly Cost |
|----------|------|--------------|
| Fargate (2 tasks) | 0.25 vCPU, 512MB | ~$18 |
| ElastiCache | cache.t4g.micro | ~$12 |
| ALB | Base + LCU | ~$20 |
| NAT Gateway | 1 | ~$32 |
| **Total** | | **~$82/month** |

*Costs are estimates for ap-southeast-2. Actual costs may vary.*

## Security

- ECS tasks run in private subnets
- Redis is not accessible from the internet
- All traffic to Redis is encrypted in transit
- Secrets stored in AWS Secrets Manager
- Non-root container user
- Security groups restrict traffic flow

## Monitoring

- **CloudWatch Container Insights** enabled for ECS metrics
- **Application logs** in CloudWatch Logs at `/ecs/bom-api-{env}`
- **ALB access logs** can be enabled by adding S3 bucket
- **Health checks** at `/health` endpoint
