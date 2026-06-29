#!/usr/bin/env node

const axios = require('axios');
const assert = require('assert');

const ENVIRONMENT = process.env.ENVIRONMENT || 'green';
const BASE_URL = process.env.BASE_URL || `http://localhost:${ENVIRONMENT === 'blue' ? 3000 : 3001}`;
const MAX_RETRIES = 30;
const RETRY_DELAY = 2000;

console.log(`Running smoke tests on ${ENVIRONMENT} environment at ${BASE_URL}`);

async function waitForHealth() {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await axios.get(`${BASE_URL}/health`);
            if (response.status === 200) {
                console.log('✅ Health check passed');
                return true;
            }
        } catch (error) {
            console.log(`⏳ Waiting for service to be ready... (${i + 1}/${MAX_RETRIES})`);
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
    throw new Error('Health check failed after max retries');
}

async function runSmokeTests() {
    try {
        await waitForHealth();
        
        console.log('✅ All smoke tests passed!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Smoke test failed:', error.message);
        process.exit(1);
    }
}

runSmokeTests();
