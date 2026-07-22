const cron = require('node-cron');

const BASE_URL = process.env.CRON_BASE_URL || 'http://localhost:3016';
const CRON_SECRET = process.env.CRON_SECRET;
const TIMEZONE = 'Asia/Karachi';

// In-memory lock to prevent overlapping runs of the same job on this instance
const locks = {
  courierifySync: false,
  alertsDispatch: false,
};

async function runJob(jobName, endpoint) {
  if (locks[jobName]) {
    console.log(`[${new Date().toISOString()}] ${jobName}: Skipped (previous run still in progress)`);
    return;
  }

  locks[jobName] = true;
  console.log(`[${new Date().toISOString()}] ${jobName}: Starting...`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Secret': CRON_SECRET,
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const body = await response.text();
    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] ${jobName}: HTTP ${response.status} -`, body);
      return;
    }
    console.log(`[${new Date().toISOString()}] ${jobName}: Completed`, body);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`[${new Date().toISOString()}] ${jobName}: Timeout after 2 minutes`);
    } else {
      console.error(`[${new Date().toISOString()}] ${jobName}: Failed -`, error.message);
    }
  } finally {
    locks[jobName] = false;
  }
}

// ============================================
// CRON SCHEDULES
// ============================================

// Courierify sync - hourly on the hour (fulfilment status + returns-to-restock queue)
cron.schedule('0 * * * *', () => {
  runJob('courierifySync', '/api/cron/courierify');
}, {
  scheduled: true,
  timezone: TIMEZONE,
});

// Stock alerts - daily at 06:30 PKT.
// dispatchAlerts notifies at most once per condition (shop+type+productId) and clears its
// ledger when a condition resolves, so this does not re-send the same alerts daily.
// Note: it can only deliver once RESEND_API_KEY (email) and/or WAHA_BASE_URL + WAHA_API_KEY
// (WhatsApp) are set — until then each run logs the missing config and records nothing.
cron.schedule('30 6 * * *', () => {
  runJob('alertsDispatch', '/api/cron/alerts');
}, {
  scheduled: true,
  timezone: TIMEZONE,
});

// ============================================
// STARTUP
// ============================================

if (!CRON_SECRET) {
  console.error('FATAL: CRON_SECRET is not set — every request would 401. Refusing to start.');
  process.exit(1);
}

console.log('========================================');
console.log('Inventorify Cron Worker Started');
console.log('========================================');
console.log(`Base URL: ${BASE_URL}`);
console.log(`Timezone: ${TIMEZONE}`);
console.log('Jobs:');
console.log('  - Courierify sync: Hourly (:00)');
console.log('  - Stock alerts: Daily at 06:30');
console.log('========================================');

process.on('SIGINT', () => {
  console.log('\nCron worker shutting down...');
  process.exit(0);
});
