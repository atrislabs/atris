'use strict';

// Scanner for the header-trust class in lib/security-audit-classes.js:
// a header the caller writes (X-Forwarded-For, X-Real-IP, Forwarded, Host,
// X-Original-URL) used to decide access. It reads a whole file, so a file
// that only logs or rate limits on the header stays quiet. A hit is a place
// to look, never a finding.

// Headers a caller can set unless a proxy the operator runs overwrites them.
const CLIENT_IP_HEADER = /x-forwarded-for|x-real-ip|x-client-ip|true-client-ip|cf-connecting-ip|x-cluster-client-ip|fastly-client-ip|HTTP_X_FORWARDED_FOR|HTTP_X_REAL_IP|HTTP_X_CLIENT_IP|HTTP_TRUE_CLIENT_IP|HTTP_CF_CONNECTING_IP/i;
// RFC 7239 Forwarded, only when named as a header, not the word in prose.
const FORWARDED_HEADER = /['"`]forwarded['"`]|HTTP_FORWARDED\b|\.forwarded\b/i;
const PATH_OVERRIDE_HEADER = /x-original-url|x-rewrite-url|x-original-uri|HTTP_X_ORIGINAL_URL|HTTP_X_REWRITE_URL/i;
const HOST_HEADER = /x-forwarded-host|x-original-host|HTTP_X_FORWARDED_HOST|\bHTTP_HOST\b|\bheaders\s*(?:\.\s*host\b|\[\s*['"`]host['"`]\s*\])|\.(?:get|getHeader|Get|header)\s*\(\s*['"`]host['"`]|\bget_host\s*\(|\b(?:req|request|r)\.(?:Host|hostname)\b|\brequest\.host\b|\bgetServerName\s*\(/i;
// Framework helpers that return a forwarded header as the client address
// unless the server names its trusted proxies (gin, echo).
const CLIENT_IP_HELPER = /\.ClientIP\s*\(\s*\)|\.RealIP\s*\(\s*\)/;
// Frameworks that turn the header into the client address for every route.
const TRUST_PROXY_ALL = /\btrust\s*proxy['"`]?\s*,\s*true\b|\bForwardedHeaders\.All\b|\bset_real_ip_from\s+0\.0\.0\.0\/0\b/i;

// Words that make a file an access decision on the client address. Parsing
// an address or naming localhost as a default is not a decision.
const IP_DECISION = /\b\w*(?:allowed|trusted|permitted|blocked|denied)\w*(?:ips|ip_?list|cidrs|networks|addrs|addresses)\b|\b(?:allow(?:ed)?[_-]?ips?|ip[_-]?allow\w*|allow[_-]?list\w*|white[_-]?list\w*|block[_-]?list\w*|black[_-]?list\w*|deny[_-]?list\w*|is[_-]?allowed[_-]?ip|trusted[_-]?(?:ips?|networks?|cidrs?|ranges?|addresses)|ip[_-]?(?:range|filter|restrict\w*|check\w*)|cidrs?|parsecidr|ip_network|isloopback|is_loopback|islocal(?:ip|address|request)\w*|is_local_(?:ip|address|request)\w*|internal[_-]?only|admin[_-]?ips?|is[_-]?private[_-]?ip\w*|private[_-]?ip\w*|geo[_-]?(?:block|fence)\w*|\w+[_-]ips)\b|['"`](?!0\.0\.0\.0)\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?['"`]|['"`]::1['"`]|\b10\.0\.0\.0\/8\b/i;
// The host compared with a local or internal name, a few lines either side.
const HOST_COMPARE = /(?:==|!=|\bin\s*[[(]|\bstartswith\b|\bstartsWith\b|\bequals\w*|\bendswith\b|\bendsWith\b|\bincludes\b)[^\n]{0,60}(?:localhost|127\.0\.0\.1|\binternal\b|\badmin\b)|(?:localhost|127\.0\.0\.1)['"`][^\n]{0,20}(?:==|!=|\.equals)/i;
// A reset, invite or sign-in link built near the host read.
const LINK_BUILD = /\b(?:reset|forgot|password|invite|invitation|magic[_-]?link|verif\w*|activat\w*)\b/i;
const URL_WORD = /https?:\/\/|\burl\b|\blink\b|\burl_for\b|\bbuild_absolute_uri\b|\$\{|%s|\+\s*['"`]\//i;
// Assigning to the host is not reading it.
const HOST_WRITE = /\b(?:req|request|r)\.(?:Host|hostname)\s*=[^=]/;

const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|<!--|;)/;

function near(lines, i, before, after) {
  return lines.slice(Math.max(0, i - before), i + after + 1).join('\n');
}

function hit(line, text, why) {
  return { line, text: `${String(text).trim().slice(0, 140)}${why ? `  [${why}]` : ''}` };
}

function scanHeaderTrust(text) {
  const lines = String(text || '').split('\n');
  const hits = [];
  const decides = IP_DECISION.test(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000 || COMMENT.test(line)) continue;
    if (PATH_OVERRIDE_HEADER.test(line)) hits.push(hit(i + 1, line, 'path picked by a header the caller sets'));
    else if (decides && (CLIENT_IP_HEADER.test(line) || FORWARDED_HEADER.test(line))) hits.push(hit(i + 1, line, 'client address read from a header the caller sets, in a file that allows or blocks by address'));
    else if (decides && CLIENT_IP_HELPER.test(line)) hits.push(hit(i + 1, line, 'client address from a framework helper that reads forwarded headers, in a file that allows or blocks by address'));
    else if (decides && TRUST_PROXY_ALL.test(line)) hits.push(hit(i + 1, line, 'every forwarded header trusted, in a file that allows or blocks by address'));
    else if (HOST_HEADER.test(line) && !HOST_WRITE.test(line)) {
      if (HOST_COMPARE.test(near(lines, i, 3, 3))) hits.push(hit(i + 1, line, 'host header compared in an access decision'));
      else {
        const around = near(lines, i, 6, 6);
        if (LINK_BUILD.test(around) && URL_WORD.test(around)) hits.push(hit(i + 1, line, 'host header in a link the server sends out'));
      }
    }
  }
  return hits;
}

// Signed inbound requests: webhooks and signed API calls. A file seeds only
// when it both reads a request and checks a signature, so a crypto helper
// with no request stays quiet. The lines named are where the signed string
// is built or compared.
const SIGNATURE_WORD = /x-hub-signature|stripe-signature|x-signature|x-slack-signature|svix-signature|webhook[_-]?secret|signing[_-]?secret|auth_signature|\bbody_?md5\b|content[_-]?md5|\bverify_?signature\b|\bverifySignature\b|\bvalidate_?signature\b|\bValidateSignature\b|\bcreateHmac\s*\(|\bhmac\.(?:new|New|compare_digest|Equal)\b|\bstring_?to_?sign\b|\bstringToSign\b|\bconstructEvent\s*\(/i;
const REQUEST_READ = /\b(?:req|request|r|ctx|c)\.(?:body|rawBody|headers?|Header|URL|query|Query|params|get_data|data|GetHeader)\b|\*http\.Request\b|\bRequest\.(?:body|headers)\b|\brequest\.(?:META|POST)\b/;
const SIGNATURE_LINE = /signature|\bhmac\b|createHmac|md5|digest|string_?to_?sign|stringToSign|timestamp|constructEvent/i;

function scanInboundSignature(text) {
  const src = String(text || '');
  if (!SIGNATURE_WORD.test(src) || !REQUEST_READ.test(src)) return [];
  const lines = src.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 40; i++) {
    const line = lines[i];
    if (line.length > 2000 || COMMENT.test(line)) continue;
    if (SIGNATURE_WORD.test(line)) hits.push(hit(i + 1, line, 'signed inbound request checked here'));
    else if (SIGNATURE_LINE.test(line) && REQUEST_READ.test(line)) hits.push(hit(i + 1, line, 'signed value read from the request'));
  }
  return hits;
}

module.exports = { scanHeaderTrust, scanInboundSignature };
