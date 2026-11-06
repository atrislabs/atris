'use strict';

// Attack classes for the sentinel audit. Each class names the trust boundary
// it guards, the source lines that make a file worth a hunter's time, and the
// guidance a hunter gets verbatim. Detection only seeds coverage: a hit is a
// place to look, never a finding. The method follows
// cloudflare/security-audit-skill (MIT): name the lower-trust principal, the
// control that should stop them, and the concrete result across the boundary.

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.php', '.rs', '.sh', '.bash', '.zsh']);
const WEB_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.vue', '.svelte', '.erb', '.rb']);
const WORKFLOW_RE = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

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
    ],
    guide: [
      'Invariant: a lower-trust value cannot pick the host, scheme, or port of a request made with this process\'s network position or credentials.',
      'Check whether a url, redirect target, webhook, or api base can come from a request, a config file in an untrusted repo, or model output. Credentials attached to a request whose host the caller chose leak those credentials.',
      'Look at redirect following and at allowlists that check the string before parsing it.',
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
    ],
    guide: [
      'Invariant: every action that reads or changes another principal\'s data, or spends shared resources, checks who is asking and whether they may.',
      'List the routes or handlers in the assigned paths. For each, find the identity check and the ownership check. Compare sibling routes: a check present on read but missing on update, delete, batch, or export is the classic gap.',
      'For a local server, check the bind address, the origin and host checks, and whether a web page in the user\'s browser can reach it (DNS rebinding, missing token, permissive CORS).',
      'Error responses that differ between "not yours" and "not found" are an enumeration oracle only when ids are secret.',
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
    ],
    guide: [
      'Invariant: a credential reaches only the party it was issued for, and never lands in logs, errors, receipts, prompts, child process environments, or files others can read.',
      'Trace each token from where it is read to every place it is written or sent. Check file modes on saved credentials, environment passed to child processes and engines, and error paths that print a request.',
      'A token sent to a host the caller can choose is also an outbound-request finding; name both classes in the root cause.',
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
    ],
    guide: [
      'Invariant: text a model reads from a lower-trust source (email, web page, issue, file in a cloned repo, another agent) cannot make the agent take an action the operator did not allow.',
      'Find where untrusted text enters a prompt, then what the model can do next: run commands, write files, send messages, spend money, push code. Permission bypass flags turn a prompt injection into code execution.',
      'Check that model output is treated as data where it reaches a shell, a path, a url, a sql query, or html. Check that secrets are not put in prompts that leave the machine.',
      'A model doing what its own operator asked is intended. The finding needs a lower-trust author of the text.',
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
      /\.(?:where|order|group|having|joins|select|pluck|find_by_sql|exec_query|execute)\s*\(\s*\"[^\"\n]*#\{|\.order\s*\(\s*params\b|\.(?:Query|QueryRow|Exec)(?:Context)?\s*\([^)\n]*fmt\.Sprintf/,
    ],
    guide: [
      'Invariant: lower-trust values reach a query only as bound parameters, never as query text, identifiers, or operators.',
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
  'A missing best practice with no affected principal or resource goes in "hardening", not in candidates. A candidate disproved by source is dropped.',
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

module.exports = {
  CLASSES,
  CLASS_BY_ID,
  CODE_EXTS,
  HUNT_METHOD,
  CANDIDATE_GATE,
  SEVERITY_ANCHORS,
};
