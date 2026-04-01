// healthcheck.js - TCP 8080 health check server for NLB
// NLB TCP health check only checks SYN-ACK — HTTP response codes are irrelevant.
// When FFmpeg dies, this server exits via process.exit(1) to refuse TCP connections → unhealthy.
const http = require('http');
const fs = require('fs');

function isFFmpegRunning() {
  // /proc-based process scan (no procps/pgrep dependency needed)
  try {
    const pids = fs.readdirSync('/proc').filter(f => /^\d+$/.test(f));
    for (const pid of pids) {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmdline.includes('ffmpeg')) return true;
      } catch (e) { /* pid vanished — ignore */ }
    }
  } catch (e) {}
  return false;
}

const startTime = Date.now();
const GRACE_PERIOD_MS = 30000; // 30s grace period for FFmpeg initialization

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
}).listen(8080, () => {
  console.log('Health check server listening on port 8080');
});

// FFmpeg liveness monitor (after grace period)
setInterval(() => {
  if (Date.now() - startTime > GRACE_PERIOD_MS && !isFFmpegRunning()) {
    console.error('FFmpeg not running — exiting to trigger NLB unhealthy and ECS task replacement');
    process.exit(1);
  }
}, 5000);
