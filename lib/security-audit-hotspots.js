'use strict';

// Where published holes live. Real advisories cluster in a few kinds of
// code: routes that take an id from the request, webhooks and other inbound
// endpoints, sign-in and session code, permission rules, file upload and
// download, admin and settings handlers, tools a model calls, and code that
// fetches a url. A quick review reads only a few areas, so it reads these
// first. Each kind lifts only the classes that hunt holes of that kind: a
// webhook file lifts access checks, not command injection. A kind is a place
// to look, never a finding.

const SEG = (words) => new RegExp(`(?:^|[/._-])(?:${words})(?:[/._-]|$)`, 'i');

const KINDS = [
  {
    id: 'id-from-request',
    text: /\b(?:params|query|body|args|vars)\s*(?:\.\s*|\[\s*['"`])\w*(?:id|Id|ID|slug|uuid|Uuid)\b|\bc\.(?:Param|Query|PostForm|DefaultQuery)\s*\(|\bctx\.(?:Param|Query)\s*\(|\bmux\.Vars\s*\(|\bchi\.URLParam\s*\(|\b(?:r|req)\.PathValue\s*\(|\brequest\.(?:args|path_params|match_info|view_args|query_params)\b|\bget_object_or_404\s*\(|\bparams\[:\w*id\]|\bc\.(?:Params|Locals)\s*\(\s*['"]\w*id/,
  },
  {
    id: 'inbound',
    path: SEG('webhooks?|callbacks?|inbound|ipn|incoming|receivers?'),
    text: /x-hub-signature|stripe-signature|x-signature|x-webhook|webhook[_-]?secret|signing[_-]?secret|auth_signature|body_md5|\bverify_?signature\b|\bverifySignature\b|\bValidateSignature\b|\bcreateHmac\s*\(|\bhmac\.(?:new|New|compare_digest|Equal)\b|\bsvix\b/i,
  },
  {
    id: 'sign-in',
    path: SEG('auth|authn|authentication|authenticators?|oauth\\w*|oidc|openid|saml|sso|login|signin|sign-in|sign_in|sessions?|passport|jwt|tokens?'),
  },
  {
    id: 'permission',
    path: SEG('permissions?|perms?|acl|polic(?:y|ies)|rbac|authz|authori[sz]ation|guards?|access|roles?|valve|rules?|middlewares?|allow-?lists?|ip-?limit\\w*'),
    text: /\b(?:can|may|has|check|require|ensure|assert|is)_?(?:Permission|Access|Role|Owner|Admin|Member|Allowed)\w*\s*\(|\bauthorize!?\s*\(|\bpermissions?\s*\[|\bRULES_MAP\b|\bpolicy_scope\b/i,
  },
  {
    id: 'files',
    path: SEG('uploads?|downloads?|attachments?|files?|assets?|imports?|exports?|archives?|storage|media|backups?'),
  },
  {
    id: 'admin',
    path: SEG('admin|settings|preferences|manage(?:ment)?|members?|orgs?|organi[sz]ations?|teams?|tenants?|workspaces?|users?|accounts?|invites?|invitations?'),
  },
  {
    id: 'url-fetch',
    text: /\bfetch\s*\(\s*(?!['"`]https?:\/\/)|\baxios(?:\.\w+)?\s*\(|\brequests\.(?:get|post|request)\s*\(|\bhttpx\.|\baiohttp\b|\burlopen\s*\(|\bhttp\.(?:Get|Post|NewRequest)\w*\s*\(|\b(?:image|avatar|webhook|callback|redirect|target|remote|source|feed|icon)_?ur[li]\b/i,
  },
  {
    id: 'tool',
    path: SEG('tools?|mcp'),
    text: /\bserver\.(?:tool|registerTool)\s*\(|@(?:mcp|server|app)\.tool\b|\bMcpServer\b|\bFastMCP\b|\bCallToolRequestSchema\b|\binputSchema\b/,
  },
  {
    id: 'route',
    path: SEG('handlers?|controllers?|routes?|routers?|api|endpoints?|views|resolvers?|services?'),
  },
];

// Which kinds of code each class's holes live in.
const CLASS_KINDS = {
  'access-control': ['id-from-request', 'permission', 'admin', 'inbound', 'files', 'route'],
  'inbound-signature': ['inbound', 'route'],
  'header-trust': ['permission', 'admin', 'inbound'],
  'sign-in-matching': ['sign-in'],
  'access-rules': ['permission', 'admin'],
  'outbound-request': ['url-fetch', 'tool', 'inbound', 'files'],
  'agent-and-llm': ['tool'],
  'path-traversal': ['files', 'tool', 'id-from-request'],
  'sql-injection': ['id-from-request', 'route', 'admin'],
  'command-injection': ['tool', 'route', 'admin'],
  'code-injection': ['tool', 'route'],
  'secrets-handling': ['sign-in', 'tool', 'admin'],
  'client-side-injection': ['route'],
  'unsafe-parsing': ['inbound', 'files'],
};

const PER_KIND = 6;
const MAX_LIFT = 24;

// The kinds a file belongs to, from its path and its text.
function kindsOf(rel, text = '') {
  const out = new Set();
  for (const k of KINDS) {
    if ((k.path && k.path.test(rel)) || (k.text && k.text.test(text))) out.add(k.id);
  }
  return out;
}

// How much a file's kinds lift a class's area in the quick plan.
function hotspotLift(clsId, kinds) {
  const want = CLASS_KINDS[clsId] || [];
  let n = 0;
  for (const k of want) if (kinds.has(k)) n += 1;
  return Math.min(MAX_LIFT, n * PER_KIND);
}

module.exports = { kindsOf, hotspotLift, KINDS, CLASS_KINDS };
