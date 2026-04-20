"""Atris Runtime Security Guard

The defense layer that makes us THE security company.

Not scanning. Not auditing. GUARDING.

This module provides:
1. Real-time tool call interception
2. Input sanitization and attack detection
3. Anomaly detection for agent behavior
4. Security event logging and alerting
5. Auto-blocking of malicious requests

Drop this into any AI agent system for instant protection.
"""

import re
import time
import hashlib
import logging
from typing import Dict, Any, List, Optional, Set, Callable
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict, deque

logger = logging.getLogger(__name__)


class ThreatLevel(Enum):
    """Threat severity levels."""
    NONE = 0
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    CRITICAL = 4


class ActionType(Enum):
    """What to do when a threat is detected."""
    ALLOW = "allow"
    LOG = "log"
    WARN = "warn"
    BLOCK = "block"
    QUARANTINE = "quarantine"


@dataclass
class SecurityEvent:
    """A security event detected by the guard."""
    timestamp: float
    threat_level: ThreatLevel
    event_type: str
    description: str
    agent_id: Optional[str] = None
    user_id: Optional[str] = None
    tool_name: Optional[str] = None
    input_hash: Optional[str] = None
    action_taken: ActionType = ActionType.LOG
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GuardConfig:
    """Configuration for the runtime guard."""
    # Blocking thresholds
    max_requests_per_minute: int = 100
    max_failed_auth_per_minute: int = 5
    max_tool_calls_per_minute: int = 50

    # Sensitive patterns to block
    block_shell_injection: bool = True
    block_path_traversal: bool = True
    block_prompt_injection: bool = True
    block_sql_injection: bool = True
    block_credential_leak: bool = True

    # Logging
    log_all_tool_calls: bool = True
    log_blocked_requests: bool = True

    # Auto-response
    auto_block_after_violations: int = 3
    quarantine_duration_seconds: int = 3600

    # Memory bounds (prevents RAM leaks in long-running processes)
    max_events: int = 10_000
    sweep_interval_seconds: int = 300  # sweep stale entries every 5 min
    stale_key_ttl_seconds: int = 3600  # remove inactive keys after 1 hour


class RuntimeGuard:
    """
    The Atris Runtime Security Guard.

    This is what makes us THE defense company.
    Drop it into any agent system for instant protection.

    Usage:
        guard = RuntimeGuard()

        # Before executing any tool
        result = guard.check_tool_call(
            agent_id="agent-123",
            user_id="user-456",
            tool_name="execute_code",
            tool_input={"code": user_input}
        )

        if result.action == ActionType.BLOCK:
            raise SecurityException(result.reason)
    """

    # Dangerous tool names that always require extra scrutiny
    DANGEROUS_TOOLS: Set[str] = {
        "execute_code", "run_bash", "shell", "eval", "exec",
        "delete_file", "remove", "rm", "rmdir",
        "modify_config", "write_file", "overwrite",
        "access_secrets", "get_credentials", "api_key",
        "send_email", "post_message", "webhook",
        "database_query", "sql", "execute_sql",
    }

    # Patterns that indicate shell injection attempts
    SHELL_INJECTION_PATTERNS: List[re.Pattern] = [
        # P3: extended dangerous-command list to include post-exploit probes
        re.compile(r';\s*(?:rm|cat|curl|wget|nc|bash|sh|python|perl|ruby|id|whoami|uname|hostname|env|printenv)', re.I),
        re.compile(r'\|\s*(?:sh|bash|zsh|python|perl|ruby|nc)', re.I),
        re.compile(r'\$\([^)]+\)'),  # Command substitution
        re.compile(r'`[^`]+`'),  # Backtick command substitution
        # P3: extended && and || to include post-exploit + nc
        re.compile(r'&&\s*(?:rm|cat|curl|wget|nc|id|whoami|uname|bash)', re.I),
        re.compile(r'\|\|?\s*(?:rm|curl|wget|nc|bash|sh)', re.I),
        re.compile(r'>\s*/(?:etc|dev|proc|sys)', re.I),

        # P3 — newline injection (smuggled shell invocation after \n or \r\n)
        re.compile(r'(?:\\n|\\r\\n)\s*/bin/(?:ba)?sh\b', re.I),
        re.compile(r'(?:\\n|\\r\\n)\s*bash\s+-i', re.I),

        # P3 — netcat with -e (classic reverse-shell backdoor)
        re.compile(r'\bnc\s+-[a-zA-Z]*e\s+/bin/', re.I),
    ]

    # Direct destructive shell commands. These should only be applied to
    # command-shaped inputs, not arbitrary chat text, so educational prompts
    # like "why is rm -rf / dangerous?" are not false positives.
    DESTRUCTIVE_SHELL_PATTERNS: List[re.Pattern] = [
        # Full root wipes
        re.compile(r'^\s*(?:sudo\s+)?rm\s+-[^\n\r]*[rf][^\n\r]*\s+/(?:\s|$)', re.I),
        # Home-directory wipes
        re.compile(r'^\s*(?:sudo\s+)?rm\s+-[^\n\r]*[rf][^\n\r]*\s+(?:~|\$HOME)(?:/|\s|$)', re.I),
        # Filesystem formatting / block-device clobbering
        re.compile(r'^\s*(?:sudo\s+)?mkfs(?:\.\w+)?\b', re.I),
        re.compile(r'^\s*(?:sudo\s+)?dd\s+if=/dev/(?:zero|random|urandom)\s+of=/dev/', re.I),
        # Mac disk erasure
        re.compile(r'^\s*(?:sudo\s+)?diskutil\s+eraseDisk\b', re.I),
    ]

    # Patterns that indicate path traversal
    PATH_TRAVERSAL_PATTERNS: List[re.Pattern] = [
        re.compile(r'\.\./'),
        re.compile(r'\.\.\\'),
        re.compile(r'/etc/(?:passwd|shadow|hosts)', re.I),
        re.compile(r'/proc/(?:self|\d+)/environ', re.I),
        re.compile(r'/proc/self/', re.I),
        re.compile(r'%2e%2e[/\\]', re.I),
        re.compile(r'%252e%252e', re.I),
        re.compile(r'\.\.%5[Cc]'),  # Windows-style backslash URL-encoded
        # Sensitive absolute paths attackers want to read
        re.compile(r'/home/[^/\s]+/\.(?:aws|ssh|gnupg)/', re.I),
        re.compile(r'/var/run/secrets/', re.I),
        re.compile(r'/var/log/(?:auth|secure)\.log', re.I),
        re.compile(r'\.aws/credentials', re.I),

        # P2 — broader /proc enumeration (version, cpuinfo, mounts, kernel info)
        re.compile(r'/proc/(?:version|cpuinfo|mounts|modules|kmsg|kallsyms|kcore|net/\w+)', re.I),

        # P2 — /root dotfiles (history, kube, docker, npm, gnupg, aws, ssh)
        re.compile(r'/root/\.(?:bash_history|zsh_history|sh_history|kube|aws|ssh|gnupg|docker|npm|cargo|netrc)', re.I),

        # P2 — file:// scheme for local path exfil (covers Windows c:/ too)
        re.compile(r'file://[/\\]*(?:[a-z]:[/\\]|etc[/\\]|root[/\\]|home[/\\]|var[/\\]|windows[/\\]|boot\.ini)', re.I),

        # P2 — /etc/<service>/<config> broader than the fixed passwd/shadow/hosts list
        # Matches e.g. /etc/mysql/my.cnf, /etc/nginx/nginx.conf, /etc/ssh/sshd_config
        re.compile(
            r'/etc/(?:mysql|postgres(?:ql)?|nginx|apache2?|httpd|ssh|kubernetes|docker|'
            r'redis|mongodb?|rabbitmq|kafka|supervisor|systemd|consul|vault|nomad)'
            r'/[\w.\-]+',
            re.I,
        ),
    ]

    # Patterns that indicate prompt injection
    PROMPT_INJECTION_PATTERNS: List[re.Pattern] = [
        re.compile(r'ignore\s+(?:previous|above|all|prior)\s+(?:the\s+)?instructions?', re.I),
        re.compile(r'ignore\s+(?:what|everything)\s+(?:you\s+)?(?:were\s+told|got|said)', re.I),
        re.compile(r'disregard\s+(?:previous|above|all|everything)', re.I),
        re.compile(r'forget\s+(?:everything|all|your|the\s+above)', re.I),
        re.compile(r'you\s+are\s+now\s+(?:a|an|the)', re.I),
        re.compile(r'new\s+instructions?:', re.I),
        re.compile(r'(?:new|updated|your\s+new)\s+system\s+prompt\s+is', re.I),
        re.compile(r'system\s*(?:prompt|message):', re.I),
        re.compile(r'\[SYSTEM\]', re.I),
        re.compile(r'<\|(?:im_start|im_end|system|assistant)\|>', re.I),

        # P1 — named-persona jailbreaks (DAN / STAN / Developer Mode / AIM / DUDE / BISH / Unrestricted Mode)
        re.compile(r'\b(?:act\s+as|you\s+(?:are|will\s+be))\s+(?:DAN|STAN|DUDE|AIM|BISH|KEVIN|EVIL)\b', re.I),
        re.compile(r'\b(?:DAN|STAN|DUDE|AIM|BISH)\s+(?:has|does|can)\s+(?:no|not)\b', re.I),
        re.compile(r'\b(?:developer|dev|god|jailbreak)\s+mode\s+(?:enabled|on|activated)\b', re.I),
        re.compile(r'\bunrestricted\s+mode\b', re.I),

        # P1 — restriction-removal asks (structural: "with/without no/any restrictions")
        re.compile(
            r'(?:with|without|have|has|no)\s+(?:no|any)?\s*'
            r'(?:restrictions?|rules?|filters?|guidelines?|limitations?|'
            r'content\s+(?:filter|polic(?:y|ies)))',
            re.I,
        ),
        re.compile(r'disable\s+(?:your\s+)?(?:safety|content\s+filter|guardrails?|restrictions?|rules?)', re.I),

        # P1 — pretext framings (hypothetical / creative writing / test-of-ability)
        re.compile(r'\bhypothetical(?:ly)?\b[^.]{0,60}(?:no\s+restrictions?|unrestricted|if\s+you\s+(?:had|could))', re.I),
        re.compile(r'creative\s+writing\s+exercise.{0,60}(?:ignore|guidelines?|rules?)', re.I),
        re.compile(r'(?:this\s+is\s+)?a?\s*test\s+of\s+your\s+ability\s+to\s+follow\s+new\s+instructions?', re.I),

        # P1 — authority impersonation
        re.compile(r"i(?:'m|\s+am)\s+your\s+(?:developer|admin|creator|operator|boss)", re.I),
        re.compile(r'i\s+am\s+(?:your\s+)?(?:developer|admin)\s+from\s+(?:openai|anthropic|google|atris)', re.I),
        re.compile(r'pretend\s+(?:i(?:\s+am|\'m)|you\s+(?:are|were))\s+(?:my|your|a|an|the)', re.I),

        # P1 — prompt-reveal asks (broader than "reveal system prompt")
        re.compile(r'(?:tell\s+me|reveal|show\s+me|output|print)\s+(?:your\s+)?(?:full\s+|system\s+|initialization\s+)?(?:prompt|instructions)', re.I),
        re.compile(r"respond\s+as\s+if\s+you\s+(?:were|had|do|don't|didn't)\s+(?:not|no)", re.I),
    ]

    # SQL injection patterns
    SQL_INJECTION_PATTERNS: List[re.Pattern] = [
        re.compile(r"'\s*(?:OR|AND)\s+['\d]", re.I),
        re.compile(r';\s*(?:DROP|DELETE|UPDATE|INSERT|TRUNCATE)', re.I),
        re.compile(r'UNION\s+(?:ALL\s+)?SELECT', re.I),
        re.compile(r'--\s*$', re.MULTILINE),
        re.compile(r'/\*.*?\*/', re.DOTALL),

        # P4 — double-quote tautology (previously only caught single-quote)
        re.compile(r'"\s*(?:OR|AND)\s+["\d]', re.I),
        # P4 — paren-balanced tautology: 1) OR ('1'='1
        re.compile(r'\)\s*(?:OR|AND)\s*\(', re.I),
        # P4 — MSSQL stored procedures (xp_cmdshell, xp_dirtree, etc)
        re.compile(r'\bEXEC\s+xp_\w+', re.I),
    ]

    # Credential-leak patterns — catches attacks that try to exfiltrate
    # secrets or ask the agent to reveal them. Kept narrow to avoid
    # false-positives on legitimate tool configuration.
    CREDENTIAL_LEAK_PATTERNS: List[re.Pattern] = [
        # Imperative asks: reveal / send / print / output / post / expose creds
        re.compile(
            r'(?:reveal|send|print|show|output|post|expose|exfiltrate|leak|dump)'
            r'[\s\w]{0,20}?'
            r'(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|'
            r'secret[_-]?key|private[_-]?key|session[_-]?token|credentials?|'
            r'env(?:ironment)?\s+(?:variables?|vars?)|password|\.env\b)',
            re.I,
        ),
        # Question-form asks: "what's in your env / .aws / .ssh / credentials"
        re.compile(
            r"what(?:'?s|\s+is)\s+(?:in\s+)?(?:your|my|the)?\s*"
            r"(?:api[_-]?key|access[_-]?token|bearer[_-]?token|session[_-]?token|"
            r"credentials?|env(?:ironment)?|\.env|\.aws|\.ssh)",
            re.I,
        ),
        # "Print/Output your <provider>-key verbatim" — provider-named asks
        re.compile(
            r"(?:print|output|reveal|show|dump)\s+(?:your|my)?\s*"
            r"(?:openai|anthropic|aws|github|slack|stripe|google)"
            r"[_\s-]*(?:api[_-]?key|key|token|secret)",
            re.I,
        ),
        # Explicit env-var exfil: $SOMETHING_KEY / $SOMETHING_TOKEN / $SOMETHING_SECRET
        re.compile(r'\$(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)\b'),
        re.compile(r'\$(?:OPENAI|ANTHROPIC|GITHUB|AWS|SLACK|GOOGLE|STRIPE)_[A-Z_]+'),
        re.compile(r'\$AUTHORIZATION_HEADER\b'),
        # AWS IMDS (instance-metadata exfil — classic SSRF credential theft)
        re.compile(r'169\.254\.169\.254', re.I),
        re.compile(r'metadata\.google\.internal', re.I),
        # Cat-on-secret-files — common exfil pattern
        re.compile(r'cat\s+[\w/.~]*\.(?:env|pem|key)\b', re.I),
        re.compile(r'cat\s+.{0,20}(?:\.aws/credentials|\.ssh/id_[rd]sa)', re.I),

        # P4 — debug/verification pretext (reframe credential-theft as legitimate ops)
        re.compile(
            r'(?:debug|troubleshoot|verify|confirm|echo\s+back)'
            r'.{0,40}?'
            r'(?:initialization\s+prompt|system\s+prompt|bearer\s+token|session\s+token|auth\s+(?:token|path))',
            re.I,
        ),
    ]

    def __init__(self, config: Optional[GuardConfig] = None):
        self.config = config or GuardConfig()
        self.events: deque = deque(maxlen=self.config.max_events)
        self.request_counts: Dict[str, List[float]] = defaultdict(list)
        self.violation_counts: Dict[str, int] = defaultdict(int)
        self.quarantined: Dict[str, float] = {}
        self._last_sweep: float = time.time()
        self._key_last_seen: Dict[str, float] = {}  # tracks when each key was last active

    # Max keys to evict per sweep to avoid O(N) latency spikes.
    _SWEEP_BATCH_SIZE = 200

    def _maybe_sweep(self):
        """Periodically remove stale keys to prevent unbounded dict growth.

        Evicts at most _SWEEP_BATCH_SIZE keys per call to avoid p99
        latency spikes when the keyspace is very large.
        """
        now = time.time()
        if now - self._last_sweep < self.config.sweep_interval_seconds:
            return
        self._last_sweep = now
        cutoff = now - self.config.stale_key_ttl_seconds

        # Incremental eviction: scan up to batch_size keys
        evicted = 0
        stale_keys = []
        for k, t in self._key_last_seen.items():
            if t < cutoff:
                stale_keys.append(k)
                evicted += 1
                if evicted >= self._SWEEP_BATCH_SIZE:
                    break

        for k in stale_keys:
            self.request_counts.pop(k, None)
            self.violation_counts.pop(k, None)
            self._key_last_seen.pop(k, None)

        # Clean expired quarantines (typically very few entries)
        expired = [k for k, exp in self.quarantined.items() if now > exp]
        for k in expired:
            del self.quarantined[k]

    def _hash_input(self, data: Any) -> str:
        """Create a hash of the input for logging without exposing sensitive data."""
        return hashlib.sha256(str(data).encode()).hexdigest()[:16]

    # Hard cap on timestamps stored per key. Even under abuse, a single
    # identity cannot grow its list beyond this. 2x the rate limit is
    # enough to detect the violation and still bounded.
    _MAX_TIMESTAMPS_PER_KEY = 500

    def _clean_old_requests(self, key: str, window_seconds: int = 60):
        """Remove requests older than the window, with a hard cap."""
        cutoff = time.time() - window_seconds
        timestamps = self.request_counts[key]
        # If the list is absurdly long (abuse), truncate first
        if len(timestamps) > self._MAX_TIMESTAMPS_PER_KEY:
            timestamps = timestamps[-self._MAX_TIMESTAMPS_PER_KEY:]
        self.request_counts[key] = [t for t in timestamps if t > cutoff]

    def _is_quarantined(self, key: str) -> bool:
        """Check if a user/agent is quarantined."""
        if key not in self.quarantined:
            return False
        if time.time() > self.quarantined[key]:
            del self.quarantined[key]
            return False
        return True

    def _quarantine(self, key: str):
        """Quarantine a user/agent."""
        self.quarantined[key] = time.time() + self.config.quarantine_duration_seconds
        logger.warning(f"QUARANTINED: {key} for {self.config.quarantine_duration_seconds}s")

    def _detect_shell_injection(self, value: str) -> Optional[str]:
        """Detect shell injection in a string value."""
        if not self.config.block_shell_injection:
            return None
        for pattern in self.SHELL_INJECTION_PATTERNS:
            if pattern.search(value):
                return f"Shell injection detected: {pattern.pattern}"
        return None

    def _detect_path_traversal(self, value: str) -> Optional[str]:
        """Detect path traversal in a string value."""
        if not self.config.block_path_traversal:
            return None
        for pattern in self.PATH_TRAVERSAL_PATTERNS:
            if pattern.search(value):
                return f"Path traversal detected: {pattern.pattern}"
        return None

    def _detect_prompt_injection(self, value: str) -> Optional[str]:
        """Detect prompt injection in a string value."""
        if not self.config.block_prompt_injection:
            return None
        for pattern in self.PROMPT_INJECTION_PATTERNS:
            if pattern.search(value):
                return f"Prompt injection detected: {pattern.pattern}"
        return None

    def _detect_sql_injection(self, value: str) -> Optional[str]:
        """Detect SQL injection in a string value."""
        if not self.config.block_sql_injection:
            return None
        for pattern in self.SQL_INJECTION_PATTERNS:
            if pattern.search(value):
                return f"SQL injection detected: {pattern.pattern}"
        return None

    def _detect_credential_leak(self, value: str) -> Optional[str]:
        """Detect credential-leak / exfiltration patterns."""
        if not self.config.block_credential_leak:
            return None
        for pattern in self.CREDENTIAL_LEAK_PATTERNS:
            if pattern.search(value):
                return f"Credential leak detected: {pattern.pattern}"
        return None

    def _detect_destructive_shell_command(self, value: str) -> Optional[str]:
        """Detect direct destructive shell commands in command-shaped inputs."""
        if not self.config.block_shell_injection:
            return None
        for pattern in self.DESTRUCTIVE_SHELL_PATTERNS:
            if pattern.search(value):
                return f"Destructive shell command detected: {pattern.pattern}"
        return None

    @staticmethod
    def _is_command_field(path: str) -> bool:
        """True when the scanned value came from a shell-command-like field."""
        tail = re.sub(r'\[\d+\]$', '', (path or '').split('.')[-1].lower())
        return tail in {"command", "cmd", "bash_command", "shell_command", "script"}

    # Cap threats per scan to bound memory per event. An attacker sending
    # a deeply nested payload with thousands of injection strings won't
    # bloat the event log.
    _MAX_THREATS_PER_SCAN = 20
    _MAX_SCAN_DEPTH = 10

    def _scan_value(self, value: Any, path: str = "", _depth: int = 0, _count: list = None) -> List[tuple]:
        """Recursively scan a value for threats. Returns list of (path, threat) tuples."""
        if _count is None:
            _count = [0]
        if _depth > self._MAX_SCAN_DEPTH or _count[0] >= self._MAX_THREATS_PER_SCAN:
            return []

        threats = []

        if isinstance(value, str):
            # Only scan first 10KB of any string to bound CPU
            scan_val = value[:10240] if len(value) > 10240 else value
            detectors = [
                (self._detect_shell_injection, "shell_injection"),
                (self._detect_path_traversal, "path_traversal"),
                (self._detect_prompt_injection, "prompt_injection"),
                (self._detect_sql_injection, "sql_injection"),
                (self._detect_credential_leak, "credential_leak"),
            ]
            if self._is_command_field(path):
                detectors.append((self._detect_destructive_shell_command, "destructive_shell_command"))
            for detector, name in detectors:
                if _count[0] >= self._MAX_THREATS_PER_SCAN:
                    break
                result = detector(scan_val)
                if result:
                    threats.append((path or "root", name, result))
                    _count[0] += 1

        elif isinstance(value, dict):
            for k, v in value.items():
                if _count[0] >= self._MAX_THREATS_PER_SCAN:
                    break
                threats.extend(self._scan_value(v, f"{path}.{k}" if path else k, _depth + 1, _count))

        elif isinstance(value, (list, tuple)):
            for i, v in enumerate(value):
                if _count[0] >= self._MAX_THREATS_PER_SCAN:
                    break
                threats.extend(self._scan_value(v, f"{path}[{i}]", _depth + 1, _count))

        return threats

    def check_tool_call(
        self,
        agent_id: str,
        user_id: str,
        tool_name: str,
        tool_input: Dict[str, Any],
    ) -> SecurityEvent:
        """
        Check a tool call for security threats.

        This is the main entry point. Call this before executing ANY tool.

        Returns a SecurityEvent with the action to take.
        """
        timestamp = time.time()
        key = f"{user_id}:{agent_id}"

        # Periodic sweep of stale keys (O(1) amortized)
        self._maybe_sweep()
        self._key_last_seen[key] = timestamp

        # Check quarantine
        if self._is_quarantined(key):
            return SecurityEvent(
                timestamp=timestamp,
                threat_level=ThreatLevel.CRITICAL,
                event_type="quarantined",
                description="Request blocked: entity is quarantined",
                agent_id=agent_id,
                user_id=user_id,
                tool_name=tool_name,
                action_taken=ActionType.BLOCK,
            )

        # Rate limiting
        self._clean_old_requests(key)
        self.request_counts[key].append(timestamp)
        if len(self.request_counts[key]) > self.config.max_requests_per_minute:
            self._record_violation(key)
            return SecurityEvent(
                timestamp=timestamp,
                threat_level=ThreatLevel.HIGH,
                event_type="rate_limit",
                description=f"Rate limit exceeded: {len(self.request_counts[key])} requests/minute",
                agent_id=agent_id,
                user_id=user_id,
                tool_name=tool_name,
                action_taken=ActionType.BLOCK,
            )

        # Check dangerous tools
        threat_level = ThreatLevel.NONE
        if tool_name.lower() in self.DANGEROUS_TOOLS:
            threat_level = ThreatLevel.MEDIUM

        # Scan input for attacks
        threats = self._scan_value(tool_input)

        if threats:
            # Found threats - determine severity and action
            threat_level = ThreatLevel.CRITICAL
            threat_descriptions = [f"{path}: {desc}" for path, _, desc in threats]

            self._record_violation(key)

            event = SecurityEvent(
                timestamp=timestamp,
                threat_level=threat_level,
                event_type="attack_detected",
                description="; ".join(threat_descriptions),
                agent_id=agent_id,
                user_id=user_id,
                tool_name=tool_name,
                input_hash=self._hash_input(tool_input),
                action_taken=ActionType.BLOCK,
                metadata={"threats": threats},
            )

            self.events.append(event)
            logger.warning(f"BLOCKED: {event.description} (agent={agent_id}, user={user_id})")

            return event

        # No threats detected
        event = SecurityEvent(
            timestamp=timestamp,
            threat_level=threat_level,
            event_type="tool_call",
            description=f"Tool call: {tool_name}",
            agent_id=agent_id,
            user_id=user_id,
            tool_name=tool_name,
            input_hash=self._hash_input(tool_input),
            action_taken=ActionType.ALLOW,
        )

        if self.config.log_all_tool_calls:
            self.events.append(event)

        return event

    def _record_violation(self, key: str):
        """Record a violation and potentially quarantine."""
        self.violation_counts[key] += 1
        if self.violation_counts[key] >= self.config.auto_block_after_violations:
            self._quarantine(key)

    def check_auth_attempt(
        self,
        user_id: str,
        success: bool,
        ip_address: Optional[str] = None,
    ) -> SecurityEvent:
        """
        Check an authentication attempt for anomalies.

        Call this after every auth attempt.
        """
        timestamp = time.time()
        key = f"auth:{user_id}"

        self._maybe_sweep()
        self._key_last_seen[key] = timestamp

        if not success:
            self._clean_old_requests(key)
            self.request_counts[key].append(timestamp)

            if len(self.request_counts[key]) > self.config.max_failed_auth_per_minute:
                self._quarantine(key)
                return SecurityEvent(
                    timestamp=timestamp,
                    threat_level=ThreatLevel.HIGH,
                    event_type="brute_force",
                    description=f"Brute force detected: {len(self.request_counts[key])} failed attempts",
                    user_id=user_id,
                    action_taken=ActionType.QUARANTINE,
                    metadata={"ip": ip_address} if ip_address else {},
                )

        return SecurityEvent(
            timestamp=timestamp,
            threat_level=ThreatLevel.NONE,
            event_type="auth_attempt",
            description=f"Auth {'success' if success else 'failure'}",
            user_id=user_id,
            action_taken=ActionType.LOG,
        )

    def get_security_report(self, hours: int = 24) -> Dict[str, Any]:
        """Generate a security report for the last N hours."""
        cutoff = time.time() - (hours * 3600)
        recent_events = [e for e in self.events if e.timestamp > cutoff]

        return {
            "period_hours": hours,
            "total_events": len(recent_events),
            "blocked_requests": len([e for e in recent_events if e.action_taken == ActionType.BLOCK]),
            "quarantined_entities": len(self.quarantined),
            "threat_breakdown": {
                level.name: len([e for e in recent_events if e.threat_level == level])
                for level in ThreatLevel
            },
            "event_types": {
                event_type: len([e for e in recent_events if e.event_type == event_type])
                for event_type in set(e.event_type for e in recent_events)
            },
            "top_blocked_tools": self._get_top_blocked_tools(recent_events),
        }

    def _get_top_blocked_tools(self, events: List[SecurityEvent], limit: int = 10) -> List[Dict[str, Any]]:
        """Get the most frequently blocked tools."""
        tool_counts: Dict[str, int] = defaultdict(int)
        for event in events:
            if event.action_taken == ActionType.BLOCK and event.tool_name:
                tool_counts[event.tool_name] += 1

        sorted_tools = sorted(tool_counts.items(), key=lambda x: x[1], reverse=True)
        return [{"tool": tool, "blocked_count": count} for tool, count in sorted_tools[:limit]]


# Global guard instance for easy import
_global_guard: Optional[RuntimeGuard] = None


def get_guard() -> RuntimeGuard:
    """Get the global RuntimeGuard instance."""
    global _global_guard
    if _global_guard is None:
        _global_guard = RuntimeGuard()
    return _global_guard


def guard_tool_call(
    agent_id: str,
    user_id: str,
    tool_name: str,
    tool_input: Dict[str, Any],
) -> SecurityEvent:
    """
    Convenience function to check a tool call.

    Usage:
        from backend.security.runtime_guard import guard_tool_call, ActionType

        result = guard_tool_call(agent_id, user_id, "execute_code", {"code": user_input})
        if result.action_taken == ActionType.BLOCK:
            raise HTTPException(403, result.description)
    """
    return get_guard().check_tool_call(agent_id, user_id, tool_name, tool_input)
