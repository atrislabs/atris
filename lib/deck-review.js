// Deck review loop — build -> thumbnail fetch -> agent visual review -> confirm.
//
// Agents should not call a deck "ready" until thumbnails pass visual review.
// This module downloads slide PNGs via the Atris Google Slides API and writes
// a review manifest agents can read (including image paths for vision review).

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const SCHEMA = 'atris.deck_review.v1';
const DEFAULT_OUT_ROOT = path.join(os.homedir(), '.atris', 'deck-review');

const AGENT_CHECKLIST = [
  'Heading and sub do not overlap',
  'Panel footers fully visible',
  'No text clipped at slide edges',
  'Column and chip wraps look intentional',
  'No purple gradients, glass blur, or hype copy visible',
  'No "it is not X, it is Y" contrast copy',
  'Stack cards have no side accent bars',
  'Avoid dashboard template fatigue (too many panel/receipt/versus/metricgrid slides)',
];

function slideCopyFields(slide) {
  return [
    slide.text,
    slide.headline,
    slide.heading,
    slide.sub,
    slide.tagline,
    slide.label,
  ].filter(Boolean);
}

function hasNotXCopy(text) {
  const t = String(text || '');
  if (/\bis not\b/i.test(t)) return true;
  if (/\bnot\b[^.]{0,40}\.\s*it is\b/i.test(t)) return true;
  return false;
}

function extractPresentationId(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw;
}

function summarizeSlide(slide) {
  if (!slide) return '';
  return slide.headline || slide.text || slide.heading || slide.number || slide.type || '';
}

const BOXED_TYPES = new Set(['panel', 'receipt', 'versus', 'metricgrid', 'stack', 'chips']);

function lintSpec(spec) {
  const findings = [];
  let boxedCount = 0;
  (spec.slides || []).forEach((slide, i) => {
    const slideNo = i + 1;
    if (BOXED_TYPES.has(slide.type) || (slide.type === 'title' && slide.panel)) {
      boxedCount += 1;
    }
    slideCopyFields(slide).forEach((copy) => {
      if (hasNotXCopy(copy)) {
        findings.push({
          severity: 'error',
          slide: slideNo,
          rule: 'not-x-contrast-copy',
          message: 'Avoid "it is not X, it is Y" framing; state the positive claim directly',
        });
      }
    });
    if (slide.type === 'panel') {
      if ((slide.heading || '').length > 34) {
        findings.push({
          severity: 'warn',
          slide: slideNo,
          rule: 'panel-heading-long',
          message: 'Panel heading may wrap and overlap the sub',
        });
      }
      if (slide.heading && slide.sub) {
        findings.push({
          severity: 'info',
          slide: slideNo,
          rule: 'panel-visual-review',
          message: 'Panel slide: check thumbnail for heading/sub spacing',
        });
      }
      const footerRight = slide.panel?.footer?.right || '';
      if (footerRight.length > 12) {
        findings.push({
          severity: 'warn',
          slide: slideNo,
          rule: 'panel-footer-long',
          message: 'Panel footer right text may clip; keep it short',
        });
      }
      if ((slide.panel?.rows || []).length >= 4) {
        findings.push({
          severity: 'warn',
          slide: slideNo,
          rule: 'panel-many-rows',
          message: 'Four-row panel: check footer clipping in thumbnail review',
        });
      }
    }
    if (slide.type === 'statement' && (slide.sub || '').length > 130) {
      findings.push({
        severity: 'warn',
        slide: slideNo,
        rule: 'statement-sub-long',
        message: 'Long statement sub may clip; shorten or split',
      });
    }
    if (slide.type === 'columns') {
      (slide.columns || []).forEach((col, j) => {
        if ((col.b || col.body || '').length > 110) {
          findings.push({
            severity: 'warn',
            slide: slideNo,
            rule: 'column-body-long',
            message: `Column ${j + 1} body may clip`,
          });
        }
      });
    }
    if (slide.type === 'chips' && (slide.chips || []).length > 4) {
      findings.push({
        severity: 'info',
        slide: slideNo,
        rule: 'chips-wrap-review',
        message: 'Many chips: verify wrap spacing in thumbnail review',
      });
    }
    if (slide.type === 'timeline' && (slide.steps || []).length >= 5) {
      findings.push({
        severity: 'info',
        slide: slideNo,
        rule: 'timeline-edge-review',
        message: 'Five-step timeline: check first/last labels in thumbnail review',
      });
    }
    if (slide.type === 'stack' && (slide.layers || []).length >= 3) {
      findings.push({
        severity: 'info',
        slide: slideNo,
        rule: 'stack-layer-review',
        message: 'Multi-layer stack: verify every layer title is readable',
      });
    }
    if (slide.type === 'hero' && (slide.mono || '').length > 52) {
      findings.push({
        severity: 'info',
        slide: slideNo,
        rule: 'hero-mono-long',
        message: 'Long mono line: check wrapping in thumbnail review',
      });
    }
  });
  if (boxedCount >= 4) {
    findings.unshift({
      severity: 'warn',
      slide: 0,
      rule: 'template-fatigue',
      message: `${boxedCount} boxed slides — consider narrative types: interstitial, lede, prose, split, statement, bignumber`,
    });
  }
  return findings;
}

function downloadUrl(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadUrl(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 300) {
        reject(new Error(`thumbnail download HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', reject);
  });
}

async function reviewDeck({
  presentationId,
  spec = null,
  specPath = null,
  outRoot = DEFAULT_OUT_ROOT,
  api,
  token,
}) {
  if (!api || !token) throw new Error('reviewDeck requires api and token');
  const id = extractPresentationId(presentationId);
  const got = await api('GET', `/presentations/${id}`, null, token);
  const slides = got.slides || (got.presentation && got.presentation.slides) || [];
  const outDir = path.join(outRoot, id);
  fs.mkdirSync(outDir, { recursive: true });

  const specLint = spec ? lintSpec(spec) : [];
  const slideReviews = [];
  for (let i = 0; i < slides.length; i++) {
    const pageId = slides[i].objectId;
    const thumb = await api('GET', `/presentations/${id}/pages/${pageId}/thumbnail`, null, token);
    const contentUrl = thumb.contentUrl;
    if (!contentUrl) throw new Error(`missing thumbnail URL for ${pageId}`);
    const file = path.join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    await downloadUrl(contentUrl, file);
    slideReviews.push({
      index: i + 1,
      pageId,
      type: (spec && spec.slides && spec.slides[i] && spec.slides[i].type) || null,
      title: summarizeSlide(spec && spec.slides && spec.slides[i]),
      thumbnail: file,
      thumbnailUrl: contentUrl,
    });
  }

  const packet = {
    schema: SCHEMA,
    presentationId: id,
    url: `https://docs.google.com/presentation/d/${id}/edit`,
    specPath: specPath || null,
    generatedAt: new Date().toISOString(),
    status: 'pending_visual_review',
    specLint,
    slides: slideReviews,
    agentReview: {
      instruction: 'Open each thumbnail and check layout before confirming the deck.',
      checklist: AGENT_CHECKLIST,
    },
    ready: false,
    confirmedAt: null,
    confirmNote: null,
  };

  const manifestPath = path.join(outDir, 'review.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { packet, manifestPath, outDir };
}

function loadReviewManifest(presentationId, outRoot = DEFAULT_OUT_ROOT) {
  const id = extractPresentationId(presentationId);
  const manifestPath = path.join(outRoot, id, 'review.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`review manifest not found: ${manifestPath}`);
  }
  return { manifestPath, packet: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
}

function confirmReview(presentationId, note = 'visual review passed', outRoot = DEFAULT_OUT_ROOT) {
  const { manifestPath, packet } = loadReviewManifest(presentationId, outRoot);
  if (packet.status === 'confirmed_visual_review') {
    return { manifestPath, packet, alreadyConfirmed: true };
  }
  packet.status = 'confirmed_visual_review';
  packet.ready = true;
  packet.confirmedAt = new Date().toISOString();
  packet.confirmNote = note;
  fs.writeFileSync(manifestPath, `${JSON.stringify(packet, null, 2)}\n`);
  return { manifestPath, packet, alreadyConfirmed: false };
}

module.exports = {
  SCHEMA,
  DEFAULT_OUT_ROOT,
  AGENT_CHECKLIST,
  extractPresentationId,
  summarizeSlide,
  lintSpec,
  downloadUrl,
  reviewDeck,
  loadReviewManifest,
  confirmReview,
};
