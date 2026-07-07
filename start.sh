#!/bin/bash
set -a
source /root/inventorify/.env
set +a
cd /root/inventorify
exec node_modules/.bin/remix-serve build/server/index.js
