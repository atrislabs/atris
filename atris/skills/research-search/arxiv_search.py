#!/usr/bin/env python3
"""
arxiv API search — returns structured JSON for papers matching a query.

Uses the arxiv Atom API (no key required, free, no rate limit for reasonable use).

Usage:
    python3 arxiv_search.py "RL creative writing" --after 2025-10-01 --limit 20
    python3 arxiv_search.py "multi-agent debate" --categories cs.AI cs.CL --limit 10
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime


ARXIV_API = "http://export.arxiv.org/api/query"
ATOM_NS = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"


def search_arxiv(
    query: str,
    after: str | None = None,
    categories: list[str] | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search arxiv API and return structured results."""

    # Build search query — use AND between words for broader matching
    # Quoting the whole phrase is too strict; split into AND-ed terms
    terms = query.strip().split()
    if len(terms) <= 3:
        term_query = " AND ".join(f"all:{t}" for t in terms)
    else:
        # For longer queries, group into bigrams + individual key terms
        term_query = " AND ".join(f"all:{t}" for t in terms)

    search_parts = [term_query]
    if categories:
        cat_query = " OR ".join(f"cat:{c}" for c in categories)
        search_parts.append(f"({cat_query})")

    search_query = " AND ".join(search_parts)

    params = {
        "search_query": search_query,
        "start": 0,
        "max_results": min(limit, 50),  # arxiv caps at 50 per request
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }

    url = f"{ARXIV_API}?{urllib.parse.urlencode(params)}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AtrisResearch/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            xml_data = resp.read().decode("utf-8")
    except Exception as e:
        print(json.dumps({"error": str(e), "papers": []}))
        sys.exit(1)

    # Parse Atom XML
    root = ET.fromstring(xml_data)
    entries = root.findall(f"{ATOM_NS}entry")

    papers = []
    for entry in entries:
        # Extract fields
        title = entry.findtext(f"{ATOM_NS}title", "").strip().replace("\n", " ")
        abstract = entry.findtext(f"{ATOM_NS}summary", "").strip().replace("\n", " ")
        published = entry.findtext(f"{ATOM_NS}published", "")
        updated = entry.findtext(f"{ATOM_NS}updated", "")

        # Authors
        authors = []
        for author in entry.findall(f"{ATOM_NS}author"):
            name = author.findtext(f"{ATOM_NS}name", "")
            if name:
                authors.append(name)

        # Links
        arxiv_url = ""
        pdf_url = ""
        for link in entry.findall(f"{ATOM_NS}link"):
            href = link.get("href", "")
            link_type = link.get("type", "")
            link_title = link.get("title", "")
            if link_title == "pdf":
                pdf_url = href
            elif link_type == "text/html" or (not arxiv_url and "abs" in href):
                arxiv_url = href

        if not arxiv_url:
            id_elem = entry.findtext(f"{ATOM_NS}id", "")
            arxiv_url = id_elem

        # Categories
        cats = []
        for cat in entry.findall(f"{ARXIV_NS}primary_category"):
            term = cat.get("term", "")
            if term:
                cats.append(term)
        for cat in entry.findall(f"{ATOM_NS}category"):
            term = cat.get("term", "")
            if term and term not in cats:
                cats.append(term)

        # Parse date
        pub_date = published[:10] if published else ""

        # Date filter
        if after and pub_date < after:
            continue

        papers.append({
            "title": title,
            "authors": authors[:5],  # Cap at 5 authors
            "abstract": abstract[:500],  # Cap abstract length
            "date": pub_date,
            "url": arxiv_url,
            "pdf": pdf_url,
            "categories": cats[:5],
            "source": "arxiv",
        })

    return papers


def main() -> int:
    parser = argparse.ArgumentParser(description="Search arxiv for papers")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--after", help="Only papers after this date (YYYY-MM-DD)")
    parser.add_argument("--categories", nargs="*", help="arxiv categories (e.g. cs.AI cs.CL)")
    parser.add_argument("--limit", type=int, default=20, help="Max results")
    args = parser.parse_args()

    papers = search_arxiv(
        query=args.query,
        after=args.after,
        categories=args.categories,
        limit=args.limit,
    )

    print(json.dumps({"papers": papers, "count": len(papers), "query": args.query}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
