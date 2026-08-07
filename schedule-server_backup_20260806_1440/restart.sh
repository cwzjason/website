#!/bin/bash
pm2 restart schedule-server
sleep 2
curl -s http://localhost:3002/api/health
