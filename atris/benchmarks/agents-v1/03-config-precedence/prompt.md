this service has three places that can set the rate limiter's maxRequests:
config.default.js (the hardcoded default), config.json (the file override),
and the RATE_LIMIT_MAX environment variable exported by bin/start.sh.

figure out which value actually wins when the service starts via
bin/start.sh, by reading how limiter.js merges the three sources.

do not edit source files.

write answers.json at the workspace root with exactly this shape:

{"maxRequests":123}
