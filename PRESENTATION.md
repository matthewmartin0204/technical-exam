# BOM Flood Warnings API - Technical Assessment

## 📑 Table of Contents

| # | Section | Jump |
|---|---------|------|
| 1 | [Executive Summary](#-executive-summary) | Overview |
| 2 | [Assumptions](#-assumptions) | Context |
| 3 | [Original Issues Identified](#-original-issues-identified) | Problems |
| 4 | [Modern Logging](#1-modern-structured-logging-pino) | Solution 1 |
| 5 | [FTP Connection Pooling](#2-ftp-connection-pooling) | Solution 2 |
| 6 | [Stream to Memory](#3-stream-to-memory-no-disk-io) | Solution 3 |
| 7 | [Redis Caching](#4-redis-caching-with-smart-ttl) | Solution 4 |
| 8 | [XML Parsing Optimization](#5-xml-parsing-optimization) | Solution 5 |
| 9 | [Production Infrastructure](#️-production-infrastructure) | AWS CDK |
| 10 | [DNS Migration Strategy](#-dns-migration-strategy) | Cutover |
| 11 | [Performance Comparison](#-performance-comparison) | Metrics |
| 12 | [Future Improvements](#-future-improvements) | Roadmap |
| 13 | [Key Decisions](#-key-decisions) | Rationale |

---

<a id="executive-summary"></a>
## 📋 Executive Summary

A legacy Node.js/Express API serving Bureau of Meteorology flood warnings, prepared for a **1000x traffic increase** with a new client.

| Metric | Before | After |
|--------|--------|-------|
| Response time (cold) | 2.7-3.5s | ~2.5s |
| Response time (cached) | 2.7-3.5s | **8ms** |
| FTP connections per request | 2-3 | Pooled (2-10 shared) |
| Horizontal scaling | ❌ Not possible | ✅ Ready |

<p align="right"><a href="#-assumptions">Next → Assumptions</a></p>

---

<a id="assumptions"></a>
## 🎯 Assumptions

The following assumptions guided this assessment:

### Infrastructure Context

| Assumption | Rationale |
|------------|-----------|
| **Current stack runs on a small cloud instance** | No infrastructure code exists - assuming EC2 or equivalent single-instance deployment |
| **Traffic scaling: 1,000 → 100,000 requests/hour** | A 100x increase justifies infrastructure investment |

### Scope Boundaries

| In Scope | Out of Scope |
|----------|--------------|
| ✅ Performance improvements | ❌ Frontend changes (despite HTML responses) |
| ✅ Caching & connection pooling | ❌ New endpoints or features |
| ✅ Horizontal scaling readiness | ❌ API contract changes |
| ✅ Production-ready logging | ❌ Breaking changes for consumers |

### Guiding Principles

| Principle | What This Means |
|-----------|-----------------|
| **Improvements needed yesterday** | No time for sweeping refactors - targeted fixes only |
| **Real results for real people** | Prioritize measurable impact over "clean code" ideals |
| **Non-breaking changes** | All changes must be transparent to existing consumers |
| **Pragmatic over perfect** | Ship working improvements, document future work |

<p align="right"><a href="#-executive-summary">← Previous</a> | <a href="#-original-issues-identified">Next → Original Issues</a></p>

---

<a id="original-issues"></a>
## 🔍 Original Issues Identified

### Critical Performance Issues

| Issue | Impact | Severity |
|-------|--------|----------|
| **New FTP connection per request** | 2-3 connections per `/warning/:id` call, ~1s each | 🔴 Critical |
| **No caching** | Every request hits external FTP server | 🔴 Critical |
| **Files written to disk** | Race conditions, I/O overhead, concurrency issues | 🔴 Critical |
| **XML parsed 4x per request** | Same XML string parsed in every method | 🟡 High |
| **Logger writes to file forever** | No rotation, no timestamps, fills disk | 🟡 High |

### Additional Code Quality Issues

| Issue | Impact | Severity |
|-------|--------|----------|
| **Missing `break` statements** | `parseProductType()` always returns "Mixed" | 🔴 Bug |
| **Weak typing (`any` everywhere)** | Runtime errors, poor maintainability | 🟡 Medium |
| **Typo: `WarningColletor`** | Unprofessional, confusing | 🟢 Low |
| **No error handling on FTP** | Client doesn't close on error | 🟡 Medium |

<p align="right"><a href="#-assumptions">← Previous</a> | <a href="#1-modern-structured-logging-pino">Next → Logging</a></p>

---

<a id="solution-1"></a>
## ✅ Top 5 Solutions Implemented

### 1. Modern Structured Logging (Pino)

**Problem:** Custom logger wrote to file forever, no timestamps, no structure.

**Solution:** Replaced with Pino for structured JSON logging.

```typescript
// Before
logger.info("some message");  // No context, no timestamp

// After
log.info({ warningId, cached: true }, "Serving cached warning");
// {"level":30,"time":1707612345678,"module":"server","warningId":"IDN10234","cached":true,"msg":"Serving cached warning"}
```

**File:** `src/main/log.ts`

**Benefits:**
- JSON output for log aggregation (CloudWatch, DataDog, etc.)
- Automatic timestamps
- Request context and structured data
- Log levels (debug, info, warn, error)

<p align="right"><a href="#-original-issues-identified">← Previous</a> | <a href="#2-ftp-connection-pooling">Next → FTP Pooling</a></p>

---

<a id="solution-2"></a>
### 2. FTP Connection Pooling

**Problem:** Each request opened 2-3 new FTP connections (~1 second each).

**Solution:** Created a connection pool using `generic-pool`.

```
Before: Request → New Connection → FTP → Close
After:  Request → Acquire from Pool → FTP → Return to Pool
```

**File:** `src/services/ftpPool.ts`

**Benefits:**
- Connections reused across requests
- Configurable pool size (2-10)
- Automatic validation and cleanup
- Graceful shutdown support

<p align="right"><a href="#1-modern-structured-logging-pino">← Previous</a> | <a href="#3-stream-to-memory-no-disk-io">Next → Stream to Memory</a></p>

---

<a id="solution-3"></a>
### 3. Stream to Memory (No Disk I/O)

**Problem:** Files downloaded to disk caused race conditions and I/O overhead.

**Solution:** Stream directly to memory buffers.

```typescript
// Before (race condition!)
await client.download(`./file.xml`, filename);
const data = fs.readFileSync(`./file.xml`);

// After (isolated per request)
const memoryStream = new MemoryWritable();
await client.downloadTo(memoryStream, filename);
const data = memoryStream.getString();
```

**File:** `src/floods/WarningCollector.ts`

<p align="right"><a href="#2-ftp-connection-pooling">← Previous</a> | <a href="#4-redis-caching-with-smart-ttl">Next → Redis Caching</a></p>

---

<a id="solution-4"></a>
### 4. Redis Caching with Smart TTL

**Problem:** Every request fetched from BOM's FTP server, even for unchanged data.

**Solution:** Redis cache using the XML's `expiry-time` field as TTL.

```
Request → Check Redis → Hit? Return cached
                      → Miss? Fetch FTP → Cache with TTL → Return
```

**File:** `src/services/cache.ts`

**Benefits:**
- **310x speedup** on cache hits (2.5s → 8ms)
- TTL automatically calculated from BOM expiry time
- Graceful degradation if Redis unavailable
- Ready for horizontal scaling

<p align="right"><a href="#3-stream-to-memory-no-disk-io">← Previous</a> | <a href="#5-xml-parsing-optimization">Next → XML Parsing</a></p>

---

<a id="solution-5"></a>
### 5. XML Parsing Optimization

**Problem:** Same XML parsed 4 times per request.

**Solution:** Parse once, memoize the result.

```typescript
// Before: 4 separate parseXmlString() calls

// After: Single parse, cached in instance
private async getParsedObject(): Promise<any> {
  if (!this.parsedObj) {
    this.parsedObj = await parseXml(this.xmlString);
  }
  return this.parsedObj;
}
```

**File:** `src/parser/FloodWarningParser.ts`

<p align="right"><a href="#4-redis-caching-with-smart-ttl">← Previous</a> | <a href="#️-production-infrastructure">Next → Infrastructure</a></p>

---

<a id="infrastructure"></a>
## 🏗️ Production Infrastructure

A complete AWS CDK stack has been created for horizontal scaling.

### Components

- **VPC** with public/private subnets
- **ECS Fargate** for container orchestration
- **Application Load Balancer** for traffic distribution
- **ElastiCache Redis** for shared caching
- **Auto-scaling** (2-20 containers based on CPU/requests)
- **Route53** for DNS (optional)
- **ECR** for container registry

### Architecture

```
                    ┌─────────────────┐
                    │   Route 53      │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │      ALB        │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────┐          ┌────▼────┐          ┌────▼────┐
   │ Fargate │          │ Fargate │          │ Fargate │
   │ Task 1  │          │ Task 2  │          │ Task N  │
   └────┬────┘          └────┬────┘          └────┬────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    ┌────────▼────────┐
                    │   ElastiCache   │
                    │   (Redis)       │
                    └─────────────────┘
```

<p align="right"><a href="#5-xml-parsing-optimization">← Previous</a> | <a href="#-dns-migration-strategy">Next → DNS Migration</a></p>

---

<a id="dns-migration"></a>
## 🔄 DNS Migration Strategy

Since this service is already in production, we need a safe cutover strategy.

### Recommended: Weighted DNS (Blue-Green)

Use Route53 weighted routing to gradually shift traffic from old to new:

```
┌─────────────────────────────────────────────────────────────┐
│                      Route 53                                │
│                   (Weighted Routing)                         │
└─────────────────┬───────────────────────┬───────────────────┘
                  │                       │
           Weight: 90%              Weight: 10%
                  │                       │
         ┌────────▼────────┐     ┌────────▼────────┐
         │   OLD SERVICE   │     │   NEW SERVICE   │
         │   (EC2/Legacy)  │     │   (ECS Fargate) │
         └─────────────────┘     └─────────────────┘
```

### Migration Phases

| Phase | Old Service | New Service | Duration | Validation |
|-------|-------------|-------------|----------|------------|
| 1. Baseline | 100% | 0% | - | Deploy new, run smoke tests |
| 2. Canary | 95% | 5% | 1 hour | Monitor errors, latency |
| 3. Partial | 50% | 50% | 2-4 hours | Compare metrics side-by-side |
| 4. Majority | 10% | 90% | 1 hour | Confirm stability |
| 5. Complete | 0% | 100% | - | Decommission old |

### Rollback Plan

If issues are detected at any phase:

```bash
# Instant rollback - shift all traffic back to old service
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890 \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "old-service",
        "Weight": 100,
        "AliasTarget": { ... }
      }
    }]
  }'
```

### Alternative Approaches

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Weighted DNS** | Gradual, easy rollback | DNS TTL delay | Most migrations |
| **ALB Path-based** | Instant switching | Same ALB needed | Same VPC |
| **Feature Flag** | Per-request control | Code changes needed | Complex logic |
| **Big Bang** | Simple | High risk | Low-traffic services |

### Pre-Migration Checklist

- [ ] New service deployed and healthy
- [ ] Health checks passing (`/health` endpoint)
- [ ] Monitoring dashboards ready
- [ ] Runbook documented
- [ ] On-call team notified
- [ ] Rollback procedure tested

<p align="right"><a href="#️-production-infrastructure">← Previous</a> | <a href="#-performance-comparison">Next → Performance</a></p>

---

<a id="performance"></a>
## 📊 Performance Comparison

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| First request (cold) | 2.7-3.5s | ~2.5s | ~20% faster |
| Subsequent request (cached) | 2.7-3.5s | 8ms | **310x faster** |
| Concurrent requests | Race conditions | Isolated | ✅ Fixed |
| 1000 requests/hour | 2000-3000 FTP connections | ~100 FTP connections | **95% reduction** |

<p align="right"><a href="#-dns-migration-strategy">← Previous</a> | <a href="#-future-improvements">Next → Future Improvements</a></p>

---

<a id="future"></a>
## 🔮 Future Improvements

| Priority | Improvement | Effort |
|----------|-------------|--------|
| High | Add request ID middleware for tracing | 1 hour |
| High | Cache the warnings list endpoint | 2 hours |
| Medium | Add Zod for runtime type validation | 4 hours |
| Medium | Add ESLint rules to prevent `any` | 1 hour |
| Low | Improve error messages for end users | 2 hours |
| Low | Add OpenAPI/Swagger documentation | 4 hours |

<p align="right"><a href="#-performance-comparison">← Previous</a> | <a href="#-key-decisions">Next → Key Decisions</a></p>

---

<a id="decisions"></a>
## 📝 Key Decisions

| Decision | Rationale |
|----------|-----------|
| **Redis over in-memory cache** | Enables horizontal scaling with shared state |
| **Connection pooling** | Reuse expensive FTP connections |
| **Stream to memory** | Avoid disk I/O and race conditions |
| **Pino over custom logger** | Industry standard, JSON output, fast |

<p align="right"><a href="#-future-improvements">← Previous</a> | <a href="#-table-of-contents">↑ Back to Top</a></p>

---

*Last updated: February 2026*
