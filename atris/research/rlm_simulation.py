#!/usr/bin/env python3
"""
RLM Simulation - Demonstrates Recursive Language Model pattern
Based on Zhang, Kraska, Khattab (MIT CSAIL, 2025)

This simulates how an RLM processes context that's too large for a single LLM call
by treating it as an external environment variable.
"""

import re
import json
from typing import Optional, Callable
from dataclasses import dataclass, field

# ============================================================
# SIMULATED CONTEXT - Imagine this is 10M tokens of documents
# ============================================================

SIMULATED_DOCUMENTS = """
=== DOCUMENT 1: Company Financials Q3 2025 ===
Revenue: $45.2M (up 23% YoY)
Net Income: $8.1M
Key Products: CloudSync Pro, DataMesh Enterprise
CEO: Sarah Chen
CFO: Marcus Williams
Employees: 342

=== DOCUMENT 2: Product Launch Memo ===
Date: October 15, 2025
Product: CloudSync Pro v3.0
Features: Real-time collaboration, AI-powered insights
Target Market: Enterprise customers (500+ employees)
Launch Date: November 1, 2025
Pricing: $99/user/month

=== DOCUMENT 3: Board Meeting Notes ===
Date: September 28, 2025
Attendees: Sarah Chen (CEO), Marcus Williams (CFO), Board Members
Discussion Points:
- Q3 performance exceeded expectations
- Approved $15M R&D budget for 2026
- New hire target: 50 engineers by Q2 2026
- Acquisition target: DataFlow Inc (pending due diligence)
Action Items:
- CFO to prepare acquisition financial model
- CEO to finalize DataFlow negotiations

=== DOCUMENT 4: Customer Feedback Summary ===
NPS Score: 72 (up from 65)
Top Requests:
1. Mobile app (requested by 45% of users)
2. Better API documentation (38%)
3. Slack integration (31%)
Churn Rate: 2.1% (industry avg: 5.2%)

=== DOCUMENT 5: Competitive Analysis ===
Main Competitors: SyncCorp, CloudBase, DataStream
Our Advantages: Price (20% lower), AI features, Customer support
Weaknesses: No mobile app, Limited integrations
Market Share: 12% (up from 8% last year)
Target: 20% market share by 2027
"""

# ============================================================
# SIMULATED LLM - Returns plausible responses for demo
# ============================================================

def simulated_llm(prompt: str, is_sub_call: bool = False) -> str:
    """Simulates LLM responses for demonstration purposes."""

    prompt_lower = prompt.lower()

    # Sub-call responses (more focused, smaller context)
    if is_sub_call:
        if "revenue" in prompt_lower or "financial" in prompt_lower:
            return "Revenue is $45.2M, up 23% YoY. Net income $8.1M."
        elif "ceo" in prompt_lower or "leadership" in prompt_lower:
            return "CEO: Sarah Chen, CFO: Marcus Williams"
        elif "product" in prompt_lower or "launch" in prompt_lower:
            return "CloudSync Pro v3.0 launching Nov 1, 2025 at $99/user/month"
        elif "acquisition" in prompt_lower:
            return "Acquisition target: DataFlow Inc, pending due diligence"
        elif "market share" in prompt_lower or "competitive" in prompt_lower:
            return "Current market share: 12%, target 20% by 2027"
        else:
            return f"Analyzed chunk, found relevant info about: {prompt[:50]}..."

    # Root LLM responses (generates code to explore context)
    if "what is the company" in prompt_lower or "summary" in prompt_lower:
        return """
I'll explore the context systematically to build a company summary.

```repl
# First, let's see the structure of the context
print(f"Context length: {len(context)} characters")
print("First 500 chars:")
print(context[:500])
```
"""
    elif "chunk" in prompt_lower or "document" in prompt_lower:
        return """
Let me process each document section:

```repl
# Split by document markers and analyze each
import re
docs = re.split(r'=== DOCUMENT \\d+:', context)
docs = [d.strip() for d in docs if d.strip()]

print(f"Found {len(docs)} documents")

# Query sub-LLM for each document type
summaries = []
for i, doc in enumerate(docs[:3]):  # Process first 3
    summary = llm_query(f"Summarize key facts from: {doc[:500]}")
    summaries.append(summary)
    print(f"Doc {i+1}: {summary}")
```
"""
    elif "acquisition" in prompt_lower:
        return """
Let me search for acquisition-related information:

```repl
# Search for acquisition mentions
lines = context.split('\\n')
acquisition_info = [l for l in lines if 'acquisition' in l.lower() or 'dataflow' in l.lower()]

print("Acquisition-related lines:")
for line in acquisition_info:
    print(f"  - {line}")

# Get more details via sub-query
details = llm_query(f"What acquisition details are in: {' '.join(acquisition_info)}")
print(f"\\nDetails: {details}")
```
"""
    else:
        return """
```repl
# Explore the context
print(f"Total context: {len(context)} chars")
print(context[:200])
```
"""


# ============================================================
# RLM REPL ENVIRONMENT
# ============================================================

@dataclass
class REPLState:
    """Tracks REPL execution state."""
    context: str
    variables: dict = field(default_factory=dict)
    output_buffer: str = ""
    sub_call_count: int = 0
    total_tokens_root: int = 0
    total_tokens_sub: int = 0


class RLMSimulator:
    """
    Simulates Recursive Language Model execution.

    Key insight: Context is stored OUTSIDE the LLM context window,
    accessed via code execution in a REPL environment.
    """

    def __init__(self, max_iterations: int = 10, verbose: bool = True):
        self.max_iterations = max_iterations
        self.verbose = verbose
        self.state: Optional[REPLState] = None
        self.iteration = 0

    def log(self, msg: str, indent: int = 0):
        if self.verbose:
            prefix = "  " * indent
            print(f"{prefix}{msg}")

    def llm_query(self, prompt: str) -> str:
        """Recursive sub-LLM call (available in REPL as llm_query())."""
        self.state.sub_call_count += 1
        self.state.total_tokens_sub += len(prompt.split()) + 50  # Rough estimate

        self.log(f"📞 Sub-LLM call #{self.state.sub_call_count}", indent=2)
        self.log(f"   Query: {prompt[:80]}...", indent=2)

        response = simulated_llm(prompt, is_sub_call=True)
        self.log(f"   Response: {response[:80]}...", indent=2)

        return response

    def execute_repl_code(self, code: str) -> str:
        """Execute Python code in sandboxed REPL environment."""
        self.log(f"\n🔧 Executing REPL code:", indent=1)
        for line in code.strip().split('\n')[:5]:  # Show first 5 lines
            self.log(f"   {line}", indent=1)
        if len(code.strip().split('\n')) > 5:
            self.log(f"   ... ({len(code.strip().split(chr(10)))} total lines)", indent=1)

        # Build execution environment
        import io
        import sys

        output_capture = io.StringIO()

        exec_globals = {
            'context': self.state.context,
            'llm_query': self.llm_query,
            'print': lambda *args, **kwargs: print(*args, file=output_capture, **kwargs),
            're': re,
            'json': json,
        }
        exec_globals.update(self.state.variables)

        try:
            exec(code, exec_globals)
            # Save any new variables
            for k, v in exec_globals.items():
                if k not in ('context', 'llm_query', 'print', 're', 'json', '__builtins__'):
                    self.state.variables[k] = v
        except Exception as e:
            output_capture.write(f"Error: {e}")

        output = output_capture.getvalue()
        self.state.output_buffer = output

        self.log(f"\n📤 REPL Output:", indent=1)
        for line in output.strip().split('\n')[:10]:
            self.log(f"   {line}", indent=1)

        return output

    def extract_code_blocks(self, response: str) -> list[str]:
        """Extract ```repl code blocks from LLM response."""
        pattern = r'```repl\n(.*?)```'
        matches = re.findall(pattern, response, re.DOTALL)
        return matches

    def check_final_answer(self, response: str) -> Optional[str]:
        """Check if response contains FINAL() or FINAL_VAR()."""
        # Check FINAL(answer)
        final_match = re.search(r'FINAL\((.*?)\)', response, re.DOTALL)
        if final_match:
            return final_match.group(1)

        # Check FINAL_VAR(variable_name)
        var_match = re.search(r'FINAL_VAR\((\w+)\)', response)
        if var_match:
            var_name = var_match.group(1)
            return str(self.state.variables.get(var_name, f"[Variable {var_name} not found]"))

        return None

    def run(self, context: str, query: str) -> dict:
        """
        Run RLM on a query with given context.

        The magic: context is NOT in the LLM's context window.
        It's stored externally and accessed via REPL code.
        """

        print("\n" + "="*60)
        print("🚀 RLM SIMULATION START")
        print("="*60)
        print(f"\n📊 Context: {len(context)} chars ({len(context.split())} words)")
        print(f"❓ Query: {query}")
        print(f"⚙️  Max iterations: {self.max_iterations}")

        # Initialize state - context stored EXTERNALLY
        self.state = REPLState(context=context)
        self.iteration = 0

        # Build initial prompt (context is NOT included - just metadata!)
        system_prompt = f"""You have access to a REPL environment with:
- `context`: A string variable ({len(context)} chars) containing documents
- `llm_query(prompt)`: Function to query a sub-LLM
- `print()`: To output results

Write code to explore the context and answer: {query}

When ready, use FINAL(answer) or FINAL_VAR(variable_name) to return."""

        current_prompt = system_prompt

        while self.iteration < self.max_iterations:
            self.iteration += 1
            print(f"\n{'─'*50}")
            print(f"📍 ITERATION {self.iteration}")
            print(f"{'─'*50}")

            # Get LLM response (simulated)
            self.state.total_tokens_root += len(current_prompt.split()) + 100
            response = simulated_llm(current_prompt)

            self.log(f"🤖 LLM Response:", indent=0)
            self.log(response[:200] + "...", indent=1)

            # Check for final answer
            final = self.check_final_answer(response)
            if final:
                print(f"\n✅ FINAL ANSWER: {final}")
                break

            # Execute any REPL code
            code_blocks = self.extract_code_blocks(response)
            for code in code_blocks:
                output = self.execute_repl_code(code)

            # Build next prompt with REPL output
            current_prompt = f"""Previous REPL output:
{self.state.output_buffer}

Continue exploring to answer: {query}
Use FINAL(answer) when ready."""

        # Summary
        print("\n" + "="*60)
        print("📈 SIMULATION SUMMARY")
        print("="*60)
        print(f"Iterations: {self.iteration}")
        print(f"Sub-LLM calls: {self.state.sub_call_count}")
        print(f"Root tokens (est): {self.state.total_tokens_root}")
        print(f"Sub tokens (est): {self.state.total_tokens_sub}")
        print(f"Variables created: {list(self.state.variables.keys())[:5]}")

        return {
            "iterations": self.iteration,
            "sub_calls": self.state.sub_call_count,
            "root_tokens": self.state.total_tokens_root,
            "sub_tokens": self.state.total_tokens_sub,
            "variables": list(self.state.variables.keys()),
        }


# ============================================================
# DEMONSTRATION
# ============================================================

def demo_basic():
    """Basic demo: Process documents to answer a question."""
    print("\n" + "🎯"*30)
    print("DEMO 1: Basic Document Q&A")
    print("🎯"*30)

    rlm = RLMSimulator(max_iterations=5)
    rlm.run(
        context=SIMULATED_DOCUMENTS,
        query="What is the company's revenue and who is the CEO?"
    )


def demo_multi_hop():
    """Multi-hop demo: Answer requires connecting multiple documents."""
    print("\n" + "🎯"*30)
    print("DEMO 2: Multi-hop Reasoning")
    print("🎯"*30)

    rlm = RLMSimulator(max_iterations=5)
    rlm.run(
        context=SIMULATED_DOCUMENTS,
        query="What acquisition is being considered and what is the R&D budget?"
    )


def demo_scale_concept():
    """Demonstrate the SCALE concept - why RLMs matter."""
    print("\n" + "🎯"*30)
    print("DEMO 3: Scale Concept")
    print("🎯"*30)

    # Simulate massive context
    massive_context = SIMULATED_DOCUMENTS * 100  # ~500KB

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║  THE KEY INSIGHT: Context as External Environment            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Traditional LLM:                                            ║
║  ┌─────────────────────────────────────┐                     ║
║  │ [Context: 500KB] + [Query] → LLM    │  ❌ Won't fit!      ║
║  └─────────────────────────────────────┘                     ║
║                                                              ║
║  RLM Approach:                                               ║
║  ┌─────────────────────────────────────┐                     ║
║  │ Context stored in REPL variable     │                     ║
║  │         ↓                           │                     ║
║  │ LLM gets: metadata + query          │  ✅ Fits!           ║
║  │         ↓                           │                     ║
║  │ LLM writes code to explore context  │                     ║
║  │         ↓                           │                     ║
║  │ Sub-LLMs process chunks             │                     ║
║  └─────────────────────────────────────┘                     ║
║                                                              ║
║  Context size: {len(massive_context):,} chars                          ║
║  LLM sees: ~500 chars (metadata only)                        ║
║  Effective expansion: {len(massive_context) // 500}x                              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
""")

    rlm = RLMSimulator(max_iterations=3, verbose=True)
    rlm.run(
        context=massive_context,
        query="Summarize the key financial metrics across all documents"
    )


if __name__ == "__main__":
    print("""
╔══════════════════════════════════════════════════════════════╗
║     RECURSIVE LANGUAGE MODELS (RLMs) - SIMULATION            ║
║     Based on Zhang, Kraska, Khattab (MIT CSAIL, 2025)        ║
╚══════════════════════════════════════════════════════════════╝
    """)

    demo_basic()
    demo_multi_hop()
    demo_scale_concept()

    print("\n" + "="*60)
    print("🎓 KEY TAKEAWAYS")
    print("="*60)
    print("""
1. CONTEXT AS ENVIRONMENT: Don't feed massive context to LLM.
   Store it externally, let LLM write code to explore it.

2. RECURSIVE SUB-CALLS: Use smaller/cheaper LLMs for chunk
   processing. Root LLM orchestrates, sub-LLMs execute.

3. REPL SANDBOX: Python execution gives LLM superpowers -
   regex, iteration, variable storage, programmatic access.

4. COST EFFICIENCY: Only process what's needed. Filter with
   code before burning tokens on sub-LLM calls.

5. SCALE: Paper shows 10M+ tokens handled effectively.
   Traditional LLMs fail catastrophically at this scale.
""")
