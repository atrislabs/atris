/**
 * Section-level three-way merge for structured markdown files.
 *
 * Parses markdown into sections (split on ## headers + YAML frontmatter).
 * Merges non-conflicting section changes. Flags same-section conflicts.
 *
 * This is what makes us better than git for context files.
 * Git merges by line. We merge by section.
 */

/**
 * Parse a markdown document into sections.
 * Returns: { __frontmatter__: string, __header__: string, sections: [{name, content}] }
 */
function parseSections(content) {
  if (!content) return { frontmatter: '', header: '', sections: [] };

  const lines = content.split('\n');
  let frontmatter = '';
  let header = '';
  const sections = [];
  let current = null;
  let inFrontmatter = false;
  let frontmatterDone = false;
  let headerLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // YAML frontmatter
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      headerLines.push(line);
      continue;
    }
    if (inFrontmatter) {
      headerLines.push(line);
      if (line.trim() === '---') {
        inFrontmatter = false;
        frontmatterDone = true;
        frontmatter = headerLines.join('\n');
        headerLines = [];
      }
      continue;
    }

    // Section headers
    if (line.startsWith('## ')) {
      // Save previous section or header
      if (current) {
        sections.push(current);
      } else if (headerLines.length > 0) {
        header = headerLines.join('\n');
      }
      current = { name: line.substring(3).trim(), content: line };
      continue;
    }

    // Content belongs to current section or header
    if (current) {
      current.content += '\n' + line;
    } else {
      headerLines.push(line);
    }
  }

  // Save last section or header
  if (current) {
    sections.push(current);
  } else if (headerLines.length > 0 && !header) {
    header = headerLines.join('\n');
  }

  return { frontmatter, header, sections };
}

/**
 * Reconstruct a markdown document from parsed sections.
 */
function reconstructDocument(parsed) {
  const parts = [];
  if (parsed.frontmatter) parts.push(parsed.frontmatter);
  if (parsed.header) parts.push(parsed.header);
  for (const section of parsed.sections) {
    parts.push(section.content);
  }
  return parts.join('\n');
}

/**
 * Three-way section merge.
 *
 * @param {string} base - Common ancestor content
 * @param {string} local - Your version
 * @param {string} remote - Their version
 * @returns {{ merged: string|null, conflicts: [{section, local, remote}] }}
 *
 * If merged is non-null, the merge succeeded (conflicts array is empty).
 * If merged is null, there are conflicts that need manual resolution.
 */
function sectionMerge(base, local, remote) {
  const baseParsed = parseSections(base);
  const localParsed = parseSections(local);
  const remoteParsed = parseSections(remote);

  const conflicts = [];

  // Merge frontmatter (field-by-field if both changed, otherwise take the changed one)
  let mergedFrontmatter = baseParsed.frontmatter;
  if (localParsed.frontmatter !== baseParsed.frontmatter && remoteParsed.frontmatter === baseParsed.frontmatter) {
    mergedFrontmatter = localParsed.frontmatter;
  } else if (remoteParsed.frontmatter !== baseParsed.frontmatter && localParsed.frontmatter === baseParsed.frontmatter) {
    mergedFrontmatter = remoteParsed.frontmatter;
  } else if (localParsed.frontmatter !== remoteParsed.frontmatter && localParsed.frontmatter !== baseParsed.frontmatter) {
    conflicts.push({ section: 'frontmatter', local: localParsed.frontmatter, remote: remoteParsed.frontmatter });
  }

  // Merge header
  let mergedHeader = baseParsed.header;
  if (localParsed.header !== baseParsed.header && remoteParsed.header === baseParsed.header) {
    mergedHeader = localParsed.header;
  } else if (remoteParsed.header !== baseParsed.header && localParsed.header === baseParsed.header) {
    mergedHeader = remoteParsed.header;
  } else if (localParsed.header !== remoteParsed.header && localParsed.header !== baseParsed.header) {
    conflicts.push({ section: 'header', local: localParsed.header, remote: remoteParsed.header });
  }

  // Build section maps
  const baseMap = {};
  for (const s of baseParsed.sections) baseMap[s.name] = s.content;
  const localMap = {};
  for (const s of localParsed.sections) localMap[s.name] = s.content;
  const remoteMap = {};
  for (const s of remoteParsed.sections) remoteMap[s.name] = s.content;

  // Get all section names preserving order (base order, then new sections)
  const allNames = [];
  const seen = new Set();
  for (const s of baseParsed.sections) { allNames.push(s.name); seen.add(s.name); }
  for (const s of localParsed.sections) { if (!seen.has(s.name)) { allNames.push(s.name); seen.add(s.name); } }
  for (const s of remoteParsed.sections) { if (!seen.has(s.name)) { allNames.push(s.name); seen.add(s.name); } }

  // Merge each section
  const mergedSections = [];
  for (const name of allNames) {
    const b = baseMap[name] || null;
    const l = localMap[name] || null;
    const r = remoteMap[name] || null;

    if (l === r) {
      // Both same — take either (or null = both deleted)
      if (l !== null) mergedSections.push({ name, content: l });
      continue;
    }

    if (b === null) {
      // New section — exists in one or both
      if (l && !r) { mergedSections.push({ name, content: l }); continue; }
      if (r && !l) { mergedSections.push({ name, content: r }); continue; }
      // Both added same-named section with different content
      conflicts.push({ section: name, local: l, remote: r });
      mergedSections.push({ name, content: l }); // default to local
      continue;
    }

    const localChanged = l !== b;
    const remoteChanged = r !== b;

    if (!localChanged && remoteChanged) {
      if (r !== null) mergedSections.push({ name, content: r });
      // else: remote deleted it, local didn't change → accept deletion
    } else if (localChanged && !remoteChanged) {
      if (l !== null) mergedSections.push({ name, content: l });
      // else: local deleted it, remote didn't change → accept deletion
    } else {
      // Both changed the same section → conflict
      conflicts.push({ section: name, local: l, remote: r });
      if (l !== null) mergedSections.push({ name, content: l }); // default to local
    }
  }

  if (conflicts.length > 0) {
    return { merged: null, conflicts };
  }

  // Reconstruct
  const merged = reconstructDocument({
    frontmatter: mergedFrontmatter,
    header: mergedHeader,
    sections: mergedSections,
  });

  return { merged, conflicts: [] };
}

module.exports = { parseSections, reconstructDocument, sectionMerge };
