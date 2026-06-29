# Blue-Green Deployment Strategy

## Overview

This project uses blue-green deployment for zero-downtime deployments.

### Architecture

- **Blue Environment**: Currently live (production)
- **Green Environment**: Staging/pre-production environment
- **Load Balancer**: Routes traffic between environments
- **Database**: Shared database with schema compatibility

## Deployment Process

### 1. Pre-deployment Checks
- Ensure database schema is backward compatible
- Run all tests
- Build artifacts

### 2. Deploy to Green
```bash
npm run deploy:blue-green staging v1.2.3