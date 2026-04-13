#!/usr/bin/env python3
"""
Semantic Scholar API search — returns structured JSON for papers.

Uses the Semantic Scholar Academic Graph API (free, no key required for basic use,
rate limited to 100 requests/5 min without key).

Usage:
    python3 scholar_search.py "reinforcement learning creative writing" --after 2025-10-01 --limit 20
    python3 scholar_search.py "LLM self-play" --min-citations 5
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
import time


S2_API = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_FIELDS = "title,authors,abstract,year,publicationDate,externalIds,citationCount,venue,openAccessPdf,url"


def search_scholar(
    query: str,
    after: str | None = None,
    limit: int = 20,
    min_citations: int = 0,
) -> list[dict]:
    """Search Semantic Scholar and return structured results."""

    # Build year filter
    year_filter = ""
    if after:
        start_year = after[:4]
        year_filter = f"{start_year}-"

    params = {
        "query": query,
        "limit": min(limit, 100),
        "fields": S2_FIELDS,
    }
    if year_filter:
        params["year"] = year_filter

    url = f"{S2_API}?{urllib.parse.urlencode(params)}"

    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "AtrisResearch/1.0",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            # Rate limited — wait and retry once
            time.sleep(5)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
            except Exception as e2:
                print(json.dumps({"error": f"Rate limited: {e2}", "papers": []}))
                sys.exit(1)
        else:
            print(json.dumps({"error": f"HTTP {e.code}: {e.reason}", "papers": []}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e), "papers": []}))
        sys.exit(1)

    results = data.get("data", [])
    papers = []

    for item in results:
        if not item:
            continue

        title = (item.get("title") or "").strip()
        if not title:
            continue

        # Authors
        authors = []
        for author in (item.get("authors") or [])[:5]:
            name = author.get("name", "")
            if name:
                authors.append(name)

        abstract = (item.get("abstract") or "")[:500]
        pub_date = item.get("publicationDate") or ""
        year = item.get("year") or ""
        citations = item.get("citationCount") or 0
        venue = item.get("venue") or ""

        # URL
        paper_url = item.get("url") or ""
        external_ids = item.get("externalIds") or {}
        arxiv_id = external_ids.get("ArXiv")
        if arxiv_id:
            paper_url = f"https://arxiv.org/abs/{arxiv_id}"

        # PDF
        pdf_info = item.get("openAccessPdf") or {}
        pdf_url = pdf_info.get("url") or ""

        # Date filter
        date_str = pub_date[:10] if pub_date else (str(year) if year else "")
        if after and date_str and date_str < after:
            continue

        # Citation filter
        if citations < min_citations:
            continue

        papers.append({
            "title": title,
            "authors": authors,
            "abstract": abstract,
            "date": date_str,
            "url": paper_url,
            "pdf": pdf_url,
            "citations": citations,
            "venue": venue,
            "source": "semantic_scholar",
        })

    return papers


def main() -> int:
    parser = argparse.ArgumentParser(description="Search Semantic Scholar for papers")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--after", help="Only papers after this date (YYYY-MM-DD)")
    parser.add_argument("--limit", type=int, default=20, help="Max results")
    parser.add_argument("--min-citations", type=int, default=0, help="Minimum citation count")
    args = parser.parse_args()

    papers = search_scholar(
        query=args.query,
        after=args.after,
        limit=args.limit,
        min_citations=args.min_citations,
    )

    print(json.dumps({"papers": papers, "count": len(papers), "query": args.query}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
