#!/bin/bash
set -a
source /root/inventorify/.env
set +a
cd /root/inventorify
exec node cron-worker.cjs
