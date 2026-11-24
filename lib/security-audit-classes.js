'use strict';

const SETTINGS = require('./security-audit-settings');
const HEADERS = require('./security-audit-headers');

// Attack classes for the sentinel audit. Each class names the trust boundary
// it guards, the source lines that make a file worth a hunter's time, and the
// guidance a hunter gets verbatim. Detection only seeds coverage: a hit is a
// place to look, never a finding. The method follows
// cloudflare/security-audit-skill (MIT): name the lower-trust principal, the
// control that should stop them, and the concrete result across the boundary.

const path = require('path');

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.php', '.rs', '.sh', '.bash', '.zsh']);
const WEB_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.vue', '.svelte', '.erb', '.rb']);
const WORKFLOW_RE = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
// Agent instruction files. Their prose rules matter only if something outside
// the model enforces them, so the blast-radius class reads them.
const RULES_FILE_RE = /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$|(?:^|\/)\.cursorrules$|(?:^|\/)\.cursor\/rules\/[^/]+$/;
// Test setup decides which database a test run wipes. Other test files stay
// skipped; only a class with testSetup reads these.
const TEST_SETUP_RE = /(?:^|\/)(?:conftest\.py|(?:global[-_.]?)?setup(?:Tests|-tests)?\.[cm]?[jt]s|(?:jest|vitest|playwright)\.(?:config|setup)\.[cm]?[jt]s)$/i;

const BLAST_CODE_DETECT = [
  // recursive deletes whose target is a variable, a glob or computed
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+[^\n]*[$*]/,
  /\bshutil\.rmtree\s*\(|\brimraf\b|\bFileUtils\.rm_rf?\b|\bos\.RemoveAll\s*\(/,
  /\b(?:rmSync|rmdirSync|rm|rmdir)\s*\([^)\n]*recursive\s*:\s*true/,
  /\bfind\b[^\n]*\s-delete\b/,
  // database wipes, resets and migrations a test or script can run
  /\b(?:drop\s+(?:table|schema|database)|truncate\s+table)\b/i,
  /\bTRUNCATE\s+["`]?\w+["`]?\s*(?:;|,|CASCADE|RESTART)/,
  /\b(?:drop_all|reset_db|flush_db|flushall|flushdb|dropDatabase)\b|\bmigrate\s+reset\b|--force-reset\b|\bdb\s+reset\b/,
  // infrastructure one command can destroy, and force flags
  /(?:^|\s)-{1,2}auto-approve\b|\bterraform\s+destroy\b/,
  /\b(?:deletion_protection|prevent_destroy)\s*=\s*false\b|\bskip_final_snapshot\s*=\s*true\b/,
  /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/,
  // money and messages that leave the building
  /\b(?:transfers|payouts|refunds|charges|paymentIntents|payment_intents)\.create\s*\(/,
  /\b(?:create_transfer|create_payout|send_payment|place_order|submit_order|sendMail|send_mail|sendEmail|send_email|send_sms|sendSms)\s*\(/,
  // an agent running inside CI
  /\buses:\s*(?:anthropics\/claude-code-action|openai\/codex-action)\b|\bclaude\s+-p\b|\bcodex\s+exec\b/,
];
// Prose rules that only the model reads. Matched in instruction files only,
// so code comments that say "never" do not seed units.
const BLAST_RULES_DETECT = [
  /\b(?:never|do not|don't|must not|ask before|code freeze)\b[^\n]*\b(?:delete|drop|truncate|push|deploy|migrat\w*|prod\w*|rm|force|send|pay|charge|merge)\b/i,
];

const CLASSES = [
  {
    id: 'command-injection',
    title: 'Command injection',
    boundary: 'shell and process launch',
    weight: 10,
    exts: CODE_EXTS,
    detect: [
      /\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync|fork)\s*\(/,
      /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/,
      /\bos\.(?:system|popen)\s*\(/,
      /\bshell\s*:\s*true\b/,
      // Ruby, Go, Java
      /\b(?:system|spawn|exec)\s*\(?\s*["'][^"'\n]*#\{|%x[{(\[]|\bIO\.popen\b|\bOpen3\.\w+|`[^`\n]*#\{/,
      /\bexec\.Command(?:Context)?\s*\(|\bRuntime\.getRuntime\(\)\.exec\b|\bnew\s+ProcessBuilder\b/,
    ],
    guide: [
      'Invariant: a lower-trust value never becomes shell syntax, a program name, or an option the caller did not intend.',
      'Trace each launched command back to its arguments. A string handed to a shell (exec, execSync, shell: true, os.system) is the risky shape; an argv array is safer but still fails when the value can start with "-" and become a flag, or picks the binary itself.',
      'Check who controls the value: a remote request, a file in an untrusted repo, a task title, model output, an environment variable set by someone else. A value the same local user typed is self-impact, not a finding.',
      'Look for quoting done by hand, values joined into one string, and option injection through "--" missing before a user path.',
    ],
  },
  {
    id: 'code-injection',
    title: 'Code injection',
    boundary: 'code evaluation',
    weight: 10,
    exts: CODE_EXTS,
    detect: [
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bvm\.(?:runIn\w+|Script|compileFunction)\b/,
      /\brequire\s*\(\s*(?!['"`])[^)]/,
      /\bimport\s*\(\s*(?!['"`])[^)]/,
      /\b(?:exec|compile)\s*\(\s*(?!['"])/,
      /\b(?:instance_eval|class_eval|module_eval|instance_exec)\b|\.(?:constantize|safe_constantize)\b|\bconst_get\s*\(|\.(?:public_)?send\s*\(\s*(?![:'\"])/,
    ],
    guide: [
      'Invariant: text from a lower-trust source is never run as code, and a module path is never chosen by it.',
      'Follow eval, new Function, vm, and dynamic require or import back to their input. A dynamic require of a path built from a file in a cloned repo, a plugin folder, or a downloaded pack loads attacker code.',
      'A require of a path the package itself ships is intended. Name the exact writer of the loaded file before calling it a finding.',
    ],
  },
  {
    id: 'path-traversal',
    title: 'Path traversal and file write',
    boundary: 'filesystem path',
    weight: 8,
    exts: CODE_EXTS,
    detect: [
      /\b(?:readFileSync|writeFileSync|readFile|writeFile|appendFileSync|createReadStream|createWriteStream|unlinkSync|rmSync|rmdirSync|renameSync|copyFileSync|symlinkSync|cpSync)\s*\(\s*(?!['"`])/,
      /\bpath\.(?:join|resolve)\s*\([^)]*\b(?:req|params|query|body|name|slug|id|input|args?|file|target)\b/,
      /\bextract(?:All)?\s*\(|\btar\b.*\bx\b|\bunzip\b/,
      /\bFile\.(?:read|write|open|binread|binwrite|delete|unlink|rename|symlink)\s*\(\s*(?!['\"])|\bFileUtils\.\w+|\bsend_file\b|\bos\.(?:Open|OpenFile|Create|ReadFile|WriteFile|Remove(?:All)?)\s*\(|\bfilepath\.Join\s*\(/,
    ],
    guide: [
      'Invariant: a path built from a lower-trust value stays inside the directory the code means, after normalization and symlink resolution.',
      'Check every join of a name, slug, id, archive entry, or url segment into a path. "..", absolute paths, encoded separators, and symlinks already in the folder are the escapes.',
      'A prefix check with startsWith on an unresolved path, or without a trailing separator, is a common miss. Writing through a symlink an attacker planted is the same class.',
      'A path the local user chose on their own command line is not a boundary crossing.',
    ],
  },
  {
    id: 'outbound-request',
    title: 'Outbound requests and SSRF',
    boundary: 'outbound network request',
    weight: 7,
    exts: CODE_EXTS,
    detect: [
      /\bfetch\s*\(\s*(?!['"`]https?:\/\/)/,
      /\bhttps?\.(?:request|get)\s*\(/,
      /\baxios(?:\.\w+)?\s*\(/,
      /\brequests\.(?:get|post|put|patch|delete|request)\s*\(/,
      /\burllib\.request\.urlopen\s*\(/,
      /\bNet::HTTP\b|\bHTTParty\b|\bFaraday\b|\bURI\.open\b|\bRestClient\b|\bhttp\.(?:Get|Post|Head|NewRequest(?:WithContext)?)\s*\(/,
      // httpx, aiohttp and client objects whose url is a variable
      /\bhttpx\.(?:get|post|put|patch|delete|request|stream)\s*\(|\baiohttp\.ClientSession\b|\burllib3\.|\bhttp\.DefaultClient\.(?:Do|Get|Post)\b/,
      /\b(?:client|session|sess|http_client|httpClient|http)\.(?:get|post|put|request|stream)\s*\(\s*(?!['"`])[A-Za-z_][\w.]*\s*[,)]/,
    ],
    strong: [/\b(?:image|avatar|webhook|callback|target|remote|feed|icon|source|download|file)_?ur[li]\b|\bfollow_redirects\s*=\s*True\b/i],
    guide: [
      'Invariant: a lower-trust value cannot pick the host, scheme, or port of a request made with this process\'s network position or credentials.',
      'Check whether a url, redirect target, webhook, or api base can come from a request, a config file in an untrusted repo, or model output. Credentials attached to a request whose host the caller chose leak those credentials.',
      'Look at redirect following and at allowlists that check the string before parsing it.',
      'Vulnerable: a tool, route or job downloads a url the caller gives (image_url, avatar, import from url, webhook target, feed) with redirects on and no block on loopback, private and link-local addresses such as 169.254.169.254. Safe: resolve the host, refuse private ranges, and check again after every redirect or turn redirects off.',
      'A model calling a tool is a caller: in an MCP server or agent tool, the url argument is chosen by whoever wrote text the model read.',
    ],
  },
  {
    id: 'access-control',
    title: 'Access control on entry points',
    boundary: 'authentication and authorization',
    weight: 9,
    exts: CODE_EXTS,
    detect: [
      /\b(?:app|router|server|api)\.(?:get|post|put|patch|delete|all|use|route)\s*\(\s*['"`]\//,
      /@(?:app|router|bp|blueprint)\.(?:get|post|put|patch|delete|route)\s*\(/,
      /\bcreateServer\s*\(/,
      /\.listen\s*\(\s*(?:\d|port|PORT)/,
      /\b(?:req|request)\.(?:headers|query|params|body)\b/,
      /\b(?:before_action|skip_before_action|authorize!?|current_user|policy_scope|load_and_authorize_resource)\b|\bparams\[/,
      /\bdef\s+(?:self\.)?(?:authorized\?|visible\?|scope_items\b|resolve\b)|\bfield\s+:\w+|\bargument\s+:\w+/,
      /^\s*(?:get|post|put|patch|delete|match|resources?)\s+['\":]/,
      /\bhttp\.HandleFunc\s*\(|\b\w+\.(?:GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(\s*\"\//,
      // an id taken from the request, a filter that lets the owner or the
      // public in, a query that widens to deleted rows, an action to rule map
      /\bc\.(?:Param|Query|PostForm|DefaultQuery)\s*\(|\bmux\.Vars\s*\(|\bchi\.URLParam\s*\(|\b(?:r|req)\.PathValue\s*\(|\bget_object_or_404\s*\(/,
      /\b(?:owner_?id|user_?id|author_?id|created_by|creator_?id)\b[^\n]{0,80}\b(?:OR|or|\|\|)\s[^\n]{0,60}\b(?:is_?public|isPublic|public|shared|visible|published)\b/i,
      /\.Unscoped\(\)|\bwith_deleted\b|\bwithTrashed\s*\(|\binclude_?deleted\b|\bparanoid\s*:\s*false\b/,
      /\b(?:RULES_MAP|PERMISSIONS?_MAP|ACTION_PERMISSIONS?|ACTION_RULES)\b|\b(?:getRules?For|rulesFor|permissionFor|permissionsFor)\w*\s*\(/,
    ],
    strong: [
      /\b(?:owner_?id|user_?id|author_?id|created_by|creator_?id)\b[^\n]{0,80}\b(?:OR|or|\|\|)\s[^\n]{0,60}\b(?:is_?public|isPublic|public|shared|visible|published)\b/i,
      /\.Unscoped\(\)|\bwith_deleted\b|\bwithTrashed\s*\(|\binclude_?deleted\b|\bparanoid\s*:\s*false\b/,
      /\b(?:RULES_MAP|PERMISSIONS?_MAP|ACTION_PERMISSIONS?|ACTION_RULES)\b/,
    ],
    guide: [
      'Invariant: every action that reads or changes another principal\'s data, or spends shared resources, checks who is asking and whether they may.',
      'List the routes or handlers in the assigned paths. For each, find the identity check and the ownership check. Compare sibling routes: a check present on read but missing on update, delete, batch, or export is the classic gap.',
      'For a local server, check the bind address, the origin and host checks, and whether a web page in the user\'s browser can reach it (DNS rebinding, missing token, permissive CORS).',
      'Error responses that differ between "not yours" and "not found" are an enumeration oracle only when ids are secret.',
      'Where the code takes the client address, host or path for a check, read where that value comes from. A header the caller writes is not the address the server saw (see the header trust class).',
      'Ownership, vulnerable vs safe: a handler loads a record by an id from the request (getById(req.params.id), First(&x, id)) and reads or changes it with no comparison of its owner or tenant to the signed-in user, or with that comparison only on a sibling route. Safe: the query itself filters by the session user or tenant (WHERE id = ? AND owner_id = ?), or the code compares record.owner with the session user before any read or write.',
      'Owner-or-public filters: a filter like owner = me OR is_public = true is right for the public view and wrong when the same filter guards a view the public must not see. Read every flag or mode the route takes (deleted=true, drafts, history, include_private, all=true, export, edit) and check that it narrows the filter to the owner. Example hole: a deleted=true flag that lists soft-deleted notes of any public book to signed-out callers.',
      'Permission maps: a table from action, message type, verb or route to the permission it needs. Compare it with every action the code accepts (the enum, the switch, the router). An action missing from the map (a multi, batch, bulk, patch, legacy or newer variant) usually reaches no check. Read what the lookup does with an action it does not know: allow or skip is the hole, deny is safe.',
    ],
  },
  {
    // A header the caller writes, used to decide access. Seeds only in files
    // that also allow or block by address, or build links from the host, so
    // a file that only logs the header stays quiet. It goes ahead with the
    // settings classes in quick mode: one wrong line opens a whole allowlist.
    id: 'header-trust',
    title: 'Caller-controlled headers in access decisions',
    boundary: 'network caller to an access decision on address, host or path',
    weight: 9,
    settings: true,
    exts: CODE_EXTS,
    detect: [],
    scan: HEADERS.scanHeaderTrust,
    guide: [
      'Invariant: an access decision on the client address (an IP allowlist, admin only from localhost, internal network trust) uses the address the server saw (RemoteAddr, the socket peer), or a forwarded header only after checking that the request came from a proxy the operator listed as trusted.',
      'X-Forwarded-For, X-Real-IP, Forwarded, True-Client-IP and CF-Connecting-IP are written by the caller unless a proxy the operator runs overwrites them. Taking the first X-Forwarded-For entry is the caller\'s choice even behind a proxy that appends, which most do. A check that reads these with no trusted-proxy test lets anyone send the allowed address.',
      'Compare sibling code that needs the same address: the rate limiter, the framework\'s client IP helper, the request logger. If they use RemoteAddr and the allowlist uses the header, that difference is the finding.',
      'An allowlist exists for the day a key or password leaks. Someone holding a leaked key from outside the allowed network is the attacker, and getting past the allowlist is the gain.',
      'X-Original-URL and X-Rewrite-URL: when the app or framework routes by these after a check made on the request path, the caller reaches a different path than the one checked.',
      'Host and X-Forwarded-Host: a reset, invite or sign-in link built from them sends the token to the caller\'s host. An admin check on host == localhost is the caller\'s choice.',
      'Framework client-IP helpers count as the header. gin c.ClientIP() and echo c.RealIP() read X-Forwarded-For and X-Real-IP from any caller unless the server setup calls SetTrustedProxies with a real list (or sets TrustedPlatform, or echo IPExtractor). Express req.ip does the same under trust proxy true. Find the router setup and check for that call: an allowlist that uses the helper with no trusted proxy setting is the hole. Safe: the allowlist reads RemoteAddr, or the setup names the trusted proxies.',
      'Correct, mark covered: the header is read only when the peer is in a configured trusted proxy list, a framework trusted-proxy setting names specific proxies, or the value is only logged, shown or used to rate limit.',
    ],
  },
  {
    // Webhooks and signed API calls. Seeds only in files that read a request
    // and check a signature, so it reads the places where a captured or
    // forged request would be let in.
    id: 'inbound-signature',
    title: 'Webhook and signed request checks',
    boundary: 'outside sender to a signed inbound request',
    weight: 9,
    // Narrow seed (a request read and a signature check in one file) and a
    // common place for real holes, so it goes ahead of the broad classes.
    boost: 40,
    exts: CODE_EXTS,
    detect: [],
    scan: HEADERS.scanInboundSignature,
    guide: [
      'Invariant: a request that claims to come from a signed sender (a webhook from a payment, chat or git provider, a signed REST call, a callback) is acted on only after the server checks a signature over the exact bytes it acts on, with its own secret, and refuses stale or replayed requests.',
      'Vulnerable: the signed string carries a digest the caller sends (body_md5, a content hash, a digest header) and the code never hashes the body it read to compare. Anyone holding one captured signed request replays it with any body. Safe: hash the raw body and compare it with the signed value, or sign the raw body itself.',
      'Vulnerable: a timestamp is part of the signed string but never compared with the clock, so a captured request works forever. Safe: refuse it when it is older than a few minutes, and refuse a nonce seen before.',
      'Vulnerable: verification is skipped when the signature header or the secret is empty, when a request field says so, or on one route, method or event type out of several. Safe: fail closed when either is missing, on every path.',
      'Vulnerable: the code verifies one form (parsed and re-encoded json, sorted query values) and acts on another (the raw body, a field outside the signed set). Safe: verify and act on the same bytes.',
      'Vulnerable: a webhook acts with no signature check at all where the provider signs its calls, trusting an id or email in the payload to pick the account.',
      'A string compare with == on the signature leaks timing; on its own it is low. Correct, mark covered: an hmac over the raw body with a constant-time compare, a timestamp window, and refusal when the secret is unset.',
    ],
  },
  {
    // Settings that live as files. The scanner reads each whole file, so a
    // rule that checks the owner stays quiet and one that does not is seeded.
    // Rules and policies carry the app code that queries the same data.
    id: 'access-rules',
    title: 'Data access rules and cloud settings',
    boundary: 'database rules, row policies, bucket policies and hosting settings',
    weight: 9,
    settings: true,
    exts: null,
    files: (rel) => SETTINGS.settingsKind(rel) !== null,
    detect: [],
    prepare: SETTINGS.prepareAccessRules,
    scan: SETTINGS.scanAccessRules,
    guards: SETTINGS.guardedNames,
    refs: SETTINGS.codeRefs,
    link: SETTINGS.linkAccessRules,
    guide: [
      'Invariant: the rule, policy or setting itself decides who may read or change each record. The app\'s own query, filter or screen is not a control: anyone holding the public config (a Firebase config, a Supabase anon key, a bucket name) can send a different query.',
      'Core question, for each rule: what does the app assume (only listed profiles are visible, users see only their own rows), and does the rule say the same? Name the field the app filters on and show whether the rule checks it. Example shape: rules say `allow read` on a collection while the app queries where listed == true, so anyone can query listed == false and read hidden records.',
      'Firebase rules: allow with no condition, if true, request.auth != null alone (any signed-in user, and sign-up is usually open), test-mode rules on request.time, creates and updates that do not pin the owner field to request.auth.uid, list rules wider than get, recursive {document=**} matches that open subcollections, storage paths not tied to request.auth.uid.',
      'Supabase and Postgres: tables in an exposed schema with row level security off, policies with using (true) or with check (true), write policies with no auth.uid() check, update policies that let a user change their own role or owner column, views and security definer functions that skip row level security, grants to anon. Read every migration: a later one can turn security off or replace a policy.',
      'Insert and update policies that check only the actor (is admin of the org, has a role) and not the row they write let that actor write rows naming any user, role or status: adding any existing user to their org as an active member without an invite, raising a member to owner, or writing a role above their own. Safe: with check pins user_id to auth.uid(), requires a matching pending invite, or caps the role written at the actor\'s own. Read the newest migration that defines each policy, including large baseline dumps.',
      'Buckets and cloud settings: public ACLs, policies with Principal "*", public access blocks set to false, allUsers bindings, databases reachable from the internet, and CORS that allows any origin with credentials.',
      'Hosting settings: rewrites or proxies that forward any path to an internal service or admin API, headers that allow any origin with credentials, image or proxy settings that fetch any host, server keys with a browser prefix (NEXT_PUBLIC_, VITE_).',
      'Example env files: a guard the code reads (an allowlist, a verify switch, a signing secret) that the example leaves out or names differently, so a fresh deploy runs with it unset. Read what the code does when the value is missing: fail closed or fail open. Name variables only; never read a real .env file or print a value.',
      'A rule that checks the owner, a policy that compares auth.uid(), and a public read of data meant to be public are correct: mark the unit covered. A public read is a finding only when you can name data the app treats as private.',
    ],
  },
  {
    // How an outside identity becomes a local account. Seeds only inside
    // files that handle a provider's sign-in, plus first-user-admin and
    // server secrets written into records.
    id: 'sign-in-matching',
    title: 'Sign-in account matching',
    boundary: 'outside identity provider to local account',
    weight: 9,
    settings: true,
    exts: CODE_EXTS,
    detect: [],
    scan: SETTINGS.scanSignIn,
    guide: [
      'Invariant: an outside identity reaches a local account only through the provider\'s stable id that was stored for that account (issuer plus subject, or provider plus provider user id), or through a verified email the account owner chose to link.',
      'Find each OAuth, OIDC or SAML callback and the line that picks the local user. A lookup by username, display name, login, preferred_username, or the part of an email before the @ lets anyone who can pick that name at any accepted provider (a self-hosted identity server, a GitHub login, a new workspace domain) sign in as the existing account with that name.',
      'A lookup by full email needs email_verified true from a provider that owns the domain. Without that check, a provider that lets users set any email gives account takeover. Linking accounts across providers by email (allowDangerousEmailAccountLinking, auto connect) is the same shape.',
      'Vulnerable: the username or account key is the email claim (username_claim = "email", user = claims["email"], a default that returns "email") and the code never reads email_verified, or reads it only behind an off-by-default flag. Many providers (Auth0 database and social connections, Cognito, Keycloak, generic OIDC) let a user sign up with an email they do not own. Safe: refuse unless email_verified is true, or key the account on the provider subject.',
      'Check that the subject is stored on first sign-in and compared on every later one, that the issuer is checked when more than one provider or tenant is accepted (multi-tenant Azure AD, any-issuer OIDC), and that SAML assertions are signature-checked before NameID is read.',
      'First user becomes admin: a count of users followed by a role write, with no lock or unique constraint, is open on every fresh deploy and to two sign-ups racing.',
      'Server secrets in records: the server\'s own OAuth client secret, signing key or service key copied into a per-user, per-workspace or per-integration record. Find every route that returns that record (settings pages, list endpoints, exports) and whether members who are not owners can read it back.',
      'A callback that matches on issuer plus subject, or on a verified email from a provider that owns the domain, is correct: mark the unit covered. Never print a secret value; name the variable.',
    ],
  },
  {
    id: 'secrets-handling',
    title: 'Secret handling and exposure',
    boundary: 'credential custody',
    weight: 9,
    exts: CODE_EXTS,
    detect: [
      /process\.env\.[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/,
      /os\.environ(?:\.get)?\s*[[(]\s*['"][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)/,
      /\b(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token)\b/i,
      /\bcredentials?\.json\b|\bkeychain\b|\.netrc\b/i,
      /\bENV(?:\.fetch)?\s*[\[(]\s*['\"][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|\bos\.Getenv\s*\(\s*\"[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)/,
      // the whole server config serialized, often as a lookup table for
      // templates or placeholders someone else writes
      /\b(?:json\.Marshal|json\.dumps|JSON\.stringify|yaml\.Marshal|yaml\.dump|to_json)\s*\(\s*(?:config|cfg|conf|settings|Config|Settings)\b/,
    ],
    strong: [/\b(?:json\.Marshal|json\.dumps|JSON\.stringify|yaml\.Marshal|yaml\.dump|to_json)\s*\(\s*(?:config|cfg|conf|settings|Config|Settings)\b/],
    guide: [
      'Invariant: a credential reaches only the party it was issued for, and never lands in logs, errors, receipts, prompts, child process environments, or files others can read.',
      'Trace each token from where it is read to every place it is written or sent. Check file modes on saved credentials, environment passed to child processes and engines, and error paths that print a request.',
      'A token sent to a host the caller can choose is also an outbound-request finding; name both classes in the root cause.',
      'Templates and placeholders resolved against the whole server config ({{config.x}}, ${env.X}, a json dump of the settings used as a lookup table) let whoever writes the template read every secret in that config. Vulnerable: marshal(config) as the lookup source for templates a tenant, server owner or user writes. Safe: an explicit list of keys they may read.',
      'A secret written to the operator\'s own logs, console or config file is not a finding: the operator already holds it. It counts only when a lower-trust person can read that place (shown to users, sent to a third party, readable by other tenants).',
    ],
  },
  {
    id: 'agent-and-llm',
    title: 'Prompt injection and agent tools',
    boundary: 'model output to tool action',
    weight: 9,
    exts: CODE_EXTS,
    detect: [
      /--dangerously-skip-permissions|--yolo\b|bypassPermissions|danger-full-access|--permission-mode['"`,\s]+(?:auto|bypass)/,
      /\b(?:anthropic|openai|messages\.create|chat\.completions|responses\.create)\b/i,
      /\b(?:prompt|system_prompt|systemPrompt)\s*[:=+]/,
      /\btool_use\b|\btools\s*:\s*\[/,
      // MCP tools, and tool arguments that pick a host, url, proxy or headers
      /\bserver\.(?:tool|registerTool)\s*\(|@(?:mcp|server|app)\.tool\b|\bFastMCP\b|\bCallToolRequestSchema\b/,
      /\b(?:host\w*|base_?url|baseURL|api_?url|apiUrl|endpoint|proxy|rawProxy|headers|url|\w+_url)\s*:\s*z\.\w+/,
    ],
    guide: [
      'Invariant: text a model reads from a lower-trust source (email, web page, issue, file in a cloned repo, another agent) cannot make the agent take an action the operator did not allow.',
      'Find where untrusted text enters a prompt, then what the model can do next: run commands, write files, send messages, spend money, push code. Permission bypass flags turn a prompt injection into code execution.',
      'Check that model output is treated as data where it reaches a shell, a path, a url, a sql query, or html. Check that secrets are not put in prompts that leave the machine.',
      'A model doing what its own operator asked is intended. The finding needs a lower-trust author of the text.',
      'MCP servers and agent tools: every tool argument is written by the model, so by whoever wrote text the model read (a web page, an issue, a document, a record). Vulnerable: an argument that picks a host, base url, proxy, extra headers, a url to fetch or a file path is passed on together with the server\'s own token ({...args, token} handed to a client, fetch(args.url) with an auth header). The token or the request goes where that text says. Safe: the host comes from config and arguments cannot override it, or the token is attached only to the configured host.',
      'A tool that masks a credential or field before the model sees it draws a boundary. An argument that reaches the masked value by another path (a crafted id, ../ in a path segment, a generic read tool) hands it to whoever steers the model. That is a finding, not the owner reading their own key.',
    ],
  },
  {
    id: 'sql-injection',
    title: 'Query injection',
    boundary: 'database query',
    weight: 8,
    exts: CODE_EXTS,
    detect: [
      /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(?:\$\{|['"`]\s*\+|%s|\.format\(|\bf["'])/i,
      /\.(?:query|execute|raw|exec)\s*\(\s*(?:`[^`]*\$\{|f["']|['"][^'"]*['"]\s*\+)/,
      /\$where\b|\.find\s*\(\s*(?:req|request)\./,
      // a request field that carries query text
      /json:"(?:raw_?)?(?:query|sql|statement)"|\b(?:raw_?sql|rawSql|RawSQL|rawquery)\b/,
      /\.(?:where|order|group|having|joins|select|pluck|find_by_sql|exec_query|execute)\s*\(\s*\"[^\"\n]*#\{|\.order\s*\(\s*params\b|\.(?:Query|QueryRow|Exec)(?:Context)?\s*\([^)\n]*fmt\.Sprintf/,
    ],
    // A request field that carries query text is the strongest seed: it goes
    // first among the files of its area.
    strong: [/json:"(?:raw_?)?(?:query|sql|statement)"|\b(?:raw_?sql|rawSql|RawSQL|rawquery)\b/],
    guide: [
      'Invariant: lower-trust values reach a query only as bound parameters, never as query text, identifiers, or operators.',
      'Vulnerable: a route takes a whole query (a rawquery, sql or statement field) and runs it, checked only by a keyword blocklist or not at all, on a connection that can read every table or write. Safe: the route builds the query from named parts, or runs caller text only on a read-only connection limited to the tables that caller may read.',
      'Trace the values in each built query. Table and column names chosen by input, ORDER BY from a request, and json operators in document stores are the misses that parameter binding does not cover.',
      'Check tenant scoping in the same query: a missing owner filter is an access-control finding in this file.',
    ],
  },
  {
    id: 'client-side-injection',
    title: 'Client-side injection',
    boundary: 'browser rendering',
    weight: 7,
    exts: WEB_EXTS,
    detect: [
      /\.innerHTML\s*[+]?=/,
      /\bdangerouslySetInnerHTML\b/,
      /\bdocument\.write\s*\(/,
      /\bv-html\b|\{@html\b/,
      /\bpostMessage\s*\(|addEventListener\s*\(\s*['"]message['"]/,
      /\bhref\s*=\s*\{?\s*(?!['"](?:https?:|\/|#))/,
      /\.html_safe\b|\braw\s*\(|<%==/,
    ],
    guide: [
      'Invariant: text from another user or an outside source renders as text, never as markup or script, and cross-window messages are accepted only from expected origins.',
      'Trace each html sink back to its value. Markdown renderers, link hrefs that allow javascript:, and message handlers that skip the origin check are the common gaps.',
      'Self-xss with no other viewer is not a finding.',
    ],
  },
  {
    id: 'unsafe-parsing',
    title: 'Unsafe parsing and deserialization',
    boundary: 'parser and deserializer',
    weight: 7,
    exts: CODE_EXTS,
    detect: [
      /\byaml\.load\s*\(/,
      /\bpickle\.loads?\s*\(|\bmarshal\.loads?\s*\(/,
      /\bunserialize\s*\(|\bMarshal\.load\b/,
      /\b__proto__\b|\bconstructor\s*\[\s*['"]prototype/,
      /\bObject\.assign\s*\(\s*\{\}\s*,\s*(?:req|body|input|data|JSON\.parse)/,
      /\bYAML\.(?:load|unsafe_load)\s*\(|\bPsych\.(?:load|unsafe_load)\b|\bOj\.load\b|\bnew\s+ObjectInputStream\b|\bgob\.NewDecoder\b/,
    ],
    guide: [
      'Invariant: parsing lower-trust input never runs code, never changes shared object prototypes, and never produces an object the next step trusts more than the input.',
      'Check unsafe loaders (yaml.load, pickle), deep merges of parsed json into config objects (prototype pollution), and parser differentials where two components read the same input differently.',
    ],
  },
  {
    id: 'weak-crypto',
    title: 'Weak tokens and comparisons',
    boundary: 'token generation and verification',
    weight: 6,
    exts: CODE_EXTS,
    detect: [
      /Math\.random\s*\(\)[^\n]*(?:token|secret|nonce|session|key|id|code|password)/i,
      /(?:token|secret|nonce|session|key|code|password)[^\n]*Math\.random\s*\(\)/i,
      /createHash\s*\(\s*['"](?:md5|sha1)['"]/,
      /\b\w*(?:token|secret|signature|hmac|digest)\w*\s*(?:===|!==|==|!=)\s*\w*(?:token|secret|signature|hmac|digest|expected)/i,
      /\bjwt\.(?:decode|verify)\s*\(|algorithms?\s*:\s*\[?\s*['"]none['"]/,
      /\bOpenSSL::(?:Cipher|PKey|HMAC|Digest|KDF)\b|\bDigest::(?:MD5|SHA1)\b|\bSecureRandom\b|\bsecure_compare\b|\bJWT\.decode\b/,
      /\bcrypto\.(?:createCipheriv|createDecipheriv|createSign|createVerify|timingSafeEqual)\b|\b(?:decrypt|encrypt|verify_signature|verify_raw|sign_raw)\s*[(]|\bcrypto\/(?:aes|cipher|rsa|ecdsa|ed25519|hmac|subtle)\b/,
    ],
    guide: [
      'Invariant: secrets, session ids, and one-time codes are unguessable, and checks of them do not leak timing or accept forged values.',
      'Math.random for anything an attacker must not guess, plain === on a secret over the network, md5 or sha1 used for integrity, and jwt decode without verify are the shapes.',
      'A random id used only for display or file names is not a finding.',
    ],
  },
  {
    id: 'supply-chain',
    title: 'Supply chain and release',
    boundary: 'install, build, and release',
    weight: 8,
    exts: null,
    files: (rel) => WORKFLOW_RE.test(rel) || /(?:^|\/)package\.json$/.test(rel) || /(?:^|\/)(?:Dockerfile|Makefile|install\.sh|setup\.py|pyproject\.toml|Gemfile|Rakefile|go\.mod)$/.test(rel) || /\.gemspec$/.test(rel),
    detect: [
      /"(?:preinstall|install|postinstall|prepare|prepublish)"\s*:/,
      /\bpull_request_target\b|\bworkflow_run\b/,
      /\buses:\s*[\w.-]+\/[\w.-]+@(?![0-9a-f]{40}\b)/,
      /\bcurl\b[^|\n]*\|\s*(?:ba|z)?sh\b|\bwget\b[^|\n]*\|\s*(?:ba|z)?sh\b/,
      /\$\{\{\s*github\.event\.(?:issue|pull_request|comment|head_commit|review)\b/,
      /\bsecrets\.[A-Z0-9_]+/,
      /^\s*(?:gem|source)\s+['\"][^'\"]+['\"]\s*,\s*(?:git|github|path):|\.add_(?:runtime_)?dependency\b|\bspec\.(?:files|executables)\b/,
    ],
    guide: [
      'Invariant: code from a lower-trust contributor or dependency cannot run with release credentials, change what ships, or execute on a user\'s machine at install time.',
      'Check workflows triggered by forks (pull_request_target, workflow_run) that check out the fork\'s code with secrets in scope, untrusted github.event text interpolated into run: shell, actions pinned to a branch instead of a commit, and install hooks.',
      'Check curl piped to a shell, unpinned downloads without a hash, and self-update paths that do not verify what they fetch.',
    ],
  },
  {
    // Adapted from jdpru/cover-your-ais, prompts/ai-codebase-safety-audit.md:
    // the in-repo checks of that audit, in this file's hunter shape. Checks
    // that live outside a repo (account tokens, synced folders, shell
    // aliases) are not source and stay out of the hunt.
    id: 'agent-blast-radius',
    title: 'Agent blast radius',
    boundary: 'coding agent to production data, infrastructure, money and people',
    weight: 8,
    exts: null,
    files: (rel) => CODE_EXTS.has(path.extname(rel).toLowerCase()) || /\.tf$/.test(rel) || WORKFLOW_RE.test(rel) || RULES_FILE_RE.test(rel) || /(?:^|\/)(?:Makefile|package\.json)$/.test(rel),
    testSetup: (rel) => TEST_SETUP_RE.test(rel),
    detect: [...BLAST_CODE_DETECT, ...BLAST_RULES_DETECT],
    detectFor: (rel) => (RULES_FILE_RE.test(rel) ? BLAST_RULES_DETECT : BLAST_CODE_DETECT),
    guide: [
      'Invariant: one command a coding agent runs in this repo, on a wrong plan, a bad variable, or instructions it read in untrusted text, cannot destroy production data or infrastructure, move money, or message people without a control outside the model.',
      'The lower-trust principal here is the agent working in the repo, not the operator. A guard that exists only as prose in AGENTS.md, CLAUDE.md or .cursorrules is no control: name the deny rule, read-only role, branch protection, cap or confirmation that backs it, or report that none does.',
      'Test setup: find which database the tests reach and whether they drop, truncate, reset or migrate it. A test config that falls back to a non-local or production host with no guard that refuses non-local hosts is the shape.',
      'Recursive deletes: trace the target back to its source. An empty or unset variable, a glob, a symlink inside the cleaned folder, or a changed HOME turns rm -rf "$DIR/" into a delete of something far larger. Look for missing set -u, ${VAR:?} guards, and a resolved path checked against the repo root.',
      'Infrastructure and git: data resources without deletion_protection or prevent_destroy, scripts that pass auto-approve or force, and backups deletable with the same token the scripts use.',
      'CI: a workflow that runs claude, codex or another agent on issue, comment or fork text while secrets or write permissions are in scope.',
      'Money and messages: a path that pays, refunds, orders or sends with no per-call cap, recipient allowlist, explicit units, or human confirmation.',
      'Remediation names the safe command next to the rule and adds a warning to any risky command that must stay, naming the hazard and its consequence (for example: DATABASE_URL is production and this drops tables). Warnings like that stop agents better than restated rules.',
      'A missing guard with no path that reaches real data, money or people goes in hardening. Never read .env files or print a credential value; name the variable only.',
    ],
  },
  {
    id: 'resource-exhaustion',
    title: 'Resource exhaustion',
    boundary: 'shared resource and spend',
    weight: 5,
    exts: CODE_EXTS,
    detect: [
      /\bnew\s+RegExp\s*\(\s*(?!['"`/])/,
      /\bwhile\s*\(\s*true\s*\)/,
      /\bmaxBuffer\s*:\s*(?:Infinity|\d{9,})/,
      /\b(?:readFileSync|JSON\.parse)\s*\([^)]*\b(?:req|body|input|stdin)\b/,
    ],
    guide: [
      'Invariant: one lower-trust caller cannot use up memory, disk, process slots, model spend, or a shared queue that other callers depend on.',
      'Check regexes built from input, unbounded reads of request bodies or files, retry loops with no cap, and work queued per request with no limit.',
      'Never test availability live. Show the unbounded path in source and the size that a single request controls.',
    ],
  },
];

const CLASS_BY_ID = new Map(CLASSES.map((c) => [c.id, c]));

// The hunting method every hunter prompt carries.
const HUNT_METHOD = [
  'Read the code at depth. Follow each input through parsing, identity, authorization, normalization, state, and the final sink. Read sibling, batch, retry, error, and legacy paths that produce the same effect.',
  'Work from a concrete invariant: name the lower-trust principal and what they start with, the value or action they control, the control that should stop them, the exact path after that control, and the smallest result across the boundary.',
  'Test sad paths only where the interface accepts them: empty, huge, duplicate, encoded, stale, concurrent, reordered, failed dependency.',
  'Stop a line of investigation as soon as the invariant is settled either way, and record the result.',
  'When you find a high or critical root cause, look for its variants inside your assigned paths. Report one candidate per root cause.',
  'You are read-only. Do not run the target, contact any network service, or use real credentials. Source evidence only.',
];

const CANDIDATE_GATE = [
  'A candidate needs a complete repository-relative trace from where the lower-trust input enters to the sink, with real file and line numbers you read yourself.',
  'Propose "confirmed" only when the trace is complete, the impact crosses a stated boundary, every condition is listed, and no layer in source prevents it.',
  'Do not strengthen a crash into code execution, ordinary work into an outage, or a same-person action into privilege gain.',
  'If a decisive fact is outside source (deployment, proxy, provider setting, who can write a file), propose "needs_validation" with the exact missing fact. It gets no severity.',
  'Before calling a library version or behavior unknown, read what is installed in the target: lockfiles, venv or .venv site-packages, node_modules, vendor folders. A fact on disk is not outside source.',
  'A dependency the repo pins but has not installed is not outside source: use the library\'s documented behavior at that version and say so.',
  'A fact the repo can answer is not outside source either: a config default, the server or router setup, the caller of a function, a framework\'s documented default. Read it and decide confirmed or dropped.',
  'A missing best practice with no affected principal or resource goes in "hardening", not in candidates. A candidate disproved by source is dropped.',
  'Build and supply-chain hygiene goes in "hardening": package signature checks turned off in a build file, a download from a moving branch or an unpinned upstream, a missing checksum, a value baked into an image label or a make target. The exception is a CI step that runs on pull requests, issues or branch names from outside contributors: untrusted input reaching it is a candidate.',
  'A separate admin, metrics, health, debug or support listener on its own port, with no sign-in, goes in "hardening" unless the repo exposes that port to the public or the same routes are reachable on the main public listener. The same routes on the main listener are a candidate.',
  'A README, a doc or a comment that calls the code a training app, a demo, trusted-users-only or intentional does not make a hole safe. Judge the code.',
  'The fingerprint names the root cause, like "lib/foo.js:runHook/shell-from-task-title". No line numbers, no severity, no verdict in it.',
  'Return an empty candidates array when nothing survives these rules. Most units should end "covered".',
];

const SEVERITY_ANCHORS = [
  'critical: an unauthenticated actor gains code execution, full data-store access, or takeover of arbitrary accounts.',
  'high: an actor fully defeats an explicit security control with real consequences (auth bypass, cross-tenant read or write, stored script for other users, authenticated code execution).',
  'medium: a real boundary violation with limited blast radius or uncommon preconditions.',
  'low: disclosure of non-secret internals, or an effect needing sustained effort for minimal gain.',
  'informational: confirmed but minimal impact.',
];

// Four checks a verifier answers before a finding may be confirmed. Each
// came from a false "confirmed" on real outside code. A failed check keeps
// the lead as a hardening note in the report; it is never dropped silently.
const CONFIRM_CHECKS = [
  {
    key: 'attacker_gain',
    pass: 'yes',
    ask: 'Does someone other than the victim gain something they could not already do, or cause harm the victim did not choose? Finishing or cancelling an action the victim already started, with no money, data or access reaching the attacker, is "no". Example: a read-only session that can complete the user\'s own pending payment. A risk the user picks in their own command or settings, such as typing a plain http address, is "no": it is a hardening note. Making a victim\'s browser load an image or send a blind request that any web page could already make, with no response, cookie or token coming back to the attacker, is "no": the most it shows is that the page was opened. Say what the attacker holds before and after: data their own ID, link or role already showed them, or a field that only labels a record and grants no rights, data or action, is "no". The other way round: when the code has its own control meant to withhold this exact thing (a redaction that hides a key from the model, a containment check on extracted paths, a per-folder access rule, a policy hook), getting past that control is a gain, so answer "yes" even when the reach is narrow and lower the severity instead. The project already drew that boundary.',
    note: 'no attacker gain',
  },
  {
    key: 'shipped_code',
    pass: 'yes',
    ask: 'Does the path start in code that runs in the shipped product? Tests, fixtures, integration tests, mocks, dev scripts, examples and CI-only helpers are "no", unless the build ships them. Example: integration test output that prints a test user\'s token. Judge by the file\'s path, its imports and the build or package files, never by commit messages, the repo name or how small the repo is. Server code with a route or main entry is "yes". Install, service and packaging scripts are "yes" only when the release steps this repo uses today ship them; one used only by an optional or retired build target is "no".',
    note: 'test or dev code, not the product',
  },
  {
    key: 'deliberate_setting',
    pass: 'no',
    ask: 'Does the hole exist only because of the value of a documented, deliberate setting the operator chooses (a flag named or commented as turning a check off, such as check_certificate: false), even if that value is the default? A setting no doc or comment explains is "no". Also "yes" when the product ships a safe and an unsafe variant of the same feature side by side and the operator picks one in their own configuration: for example a source-address rule that trusts a forwarded header next to one that uses the connecting peer, or a hook that runs only when the operator writes it. The evidence is the line that defines the variant the operator picked or the safe alternative beside it. A default the operator never chooses is not a pick: a check the product leaves out of its own built-in routes is "no". Also "yes" when the hole needs the operator to leave a required setting empty or invalid, a state in which the product\'s own normal use fails at once (an empty signing secret that also breaks the operator\'s own signed calls).',
    note: 'documented operator setting',
  },
  {
    key: 'hygiene_only',
    pass: 'no',
    ask: 'Is this only build or supply-chain hygiene, or an internal admin port? Build hygiene: package signature checks turned off in a Dockerfile, Containerfile, Makefile or spec file, a download from a moving branch or an unpinned upstream, a missing checksum, a value placed into an image label or a make target. Internal admin port: a separate admin, metrics, health, debug or support listener on its own port with no sign-in, which this repo does not publish to the outside. Both are "yes". "No" when outside contributors\' pull requests, issues or branch names reach a CI step, or when the same routes answer on the main public listener.',
    note: 'build hygiene or internal admin port',
  },
  {
    key: 'insider_only',
    pass: 'no',
    ask: 'Does every way in need access only an insider has before the attack starts: reading server logs, turning on debug logging, a shell on the host, the database, the admin console or the deploy config? Example: sign-in challenges written to debug logs. Needing another user\'s random ID or token, or a request captured from another user and sent again, is not insider access: answer "no" and name it in "secret_barrier" (random_id or captured_request). Such a finding is still confirmed, at a lower severity, because these values leak through links, logs and proxies. A leaked key or password used from outside, a guessable or sequential ID, or an ID shown to other users is "no". Two more count as "yes": a remote service that already holds the product\'s own admin credential (a control panel or orchestrator that can reconfigure it anyway), and a project or repo whose code the tool already runs (a config file written in code, build scripts), when the attack only needs that project to contain some other file or setting. The same holds for the project folder the operator runs a command-line or developer tool in: a settings file there (naming a server, host, user or path) and its committed files and symlinks are the operator\'s own, so "yes". Answer "no" when the tool\'s job is to handle folders from people it does not trust (a code reviewer, a scanner, a bot or CI on outside pull requests, an installer of third-party packages), or when the file arrives from outside (a download, an upload, a pull request, an archive from another service).',
    note: 'needs insider access first',
  },
];

module.exports = {
  CLASSES,
  CLASS_BY_ID,
  CODE_EXTS,
  CONFIRM_CHECKS,
  HUNT_METHOD,
  CANDIDATE_GATE,
  SEVERITY_ANCHORS,
};
