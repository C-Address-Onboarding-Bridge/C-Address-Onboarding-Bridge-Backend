#!/bin/bash

echo "🔄 Initiating rollback..."

# Get current active environment
CURRENT_ENV=$(aws elbv2 describe-listeners \
    --listener-arn $LISTENER_ARN \
    --query 'Listeners[0].DefaultActions[0].TargetGroupArn' \
    --output text | grep -q "blue" && echo "blue" || echo "green")

# Determine target for rollback
if [ "$CURRENT_ENV" == "blue" ]; then
    TARGET_ENV="green"
else
    TARGET_ENV="blue"
fi

echo "Rolling back from $CURRENT_ENV to $TARGET_ENV"

# Switch load balancer
aws elbv2 modify-listener \
    --listener-arn $LISTENER_ARN \
    --default-actions Type=forward,TargetGroupArn=$(aws elbv2 describe-target-groups --names $TARGET_ENV-$ENVIRONMENT --query 'TargetGroups[0].TargetGroupArn' --output text)

echo "✅ Rollback complete to $TARGET_ENV"
