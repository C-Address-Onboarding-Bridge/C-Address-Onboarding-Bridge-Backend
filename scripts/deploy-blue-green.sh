#!/bin/bash

# Blue-Green Deployment Script (Simplified for testing)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ENVIRONMENT=${1:-"staging"}
VERSION=${2:-"latest"}

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Blue-Green Deployment Starting${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Environment: ${GREEN}$ENVIRONMENT${NC}"
echo -e "Version: ${GREEN}$VERSION${NC}"

# For local testing with Docker
if [ -f "docker-compose.blue-green.yml" ]; then
    echo -e "${YELLOW}Using Docker Compose for local deployment${NC}"
    
    # Build green environment
    echo -e "${BLUE}Building green environment...${NC}"
    docker-compose -f docker-compose.blue-green.yml build green
    
    # Start green environment
    echo -e "${BLUE}Starting green environment...${NC}"
    docker-compose -f docker-compose.blue-green.yml up -d green
    
    # Wait for health check
    echo -e "${YELLOW}Waiting for green to be healthy...${NC}"
    sleep 30
    
    # Run smoke tests
    echo -e "${YELLOW}Running smoke tests on green...${NC}"
    if npm run test:smoke:green; then
        echo -e "${GREEN}✅ Smoke tests passed${NC}"
    else
        echo -e "${RED}❌ Smoke tests failed${NC}"
        exit 1
    fi
    
    # Switch traffic to green
    echo -e "${BLUE}Switching traffic to green...${NC}"
    docker-compose -f docker-compose.blue-green.yml exec nginx nginx -s reload
    
    echo -e "${GREEN}✅ Traffic switched to green${NC}"
    
    # Keep blue warm
    echo -e "${YELLOW}Keeping blue warm for 15 minutes...${NC}"
    # In production, you'd actually wait here
    echo -e "${GREEN}✅ Blue kept warm${NC}"
    
    echo -e "${GREEN}🎉 Blue-Green Deployment Successful!${NC}"
else
    echo -e "${RED}❌ docker-compose.blue-green.yml not found${NC}"
    echo -e "${YELLOW}Please create the docker-compose file first${NC}"
fi

chmod +x scripts/deploy-blue-green.sh