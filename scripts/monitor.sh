#!/bin/bash

echo "📊 Starting monitoring..."

# Monitor error rates
while true; do
    ERROR_RATE=$(aws cloudwatch get-metric-statistics \
        --namespace "AWS/ECS" \
        --metric-name "ErrorRate" \
        --dimensions Name=ServiceName,Value=$SERVICE_NAME \
        --start-time "$(date -d '5 minutes ago' -u +'%Y-%m-%dT%H:%M:%S')" \
        --end-time "$(date -u +'%Y-%m-%dT%H:%M:%S')" \
        --period 60 \
        --statistics Average \
        --query 'Datapoints[0].Average' \
        --output text)
    
    if [ -n "$ERROR_RATE" ] && [ "$ERROR_RATE" != "null" ] && (( $(echo "$ERROR_RATE > 5" | bc -l) )); then
        echo "⚠️ Error rate spike detected: $ERROR_RATE%"
        echo "Initiating rollback..."
        ./scripts/rollback.sh
        exit 1
    fi
    
    echo "✅ Error rate: $ERROR_RATE%"
    sleep 60
done
