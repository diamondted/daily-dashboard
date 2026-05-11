#!/usr/bin/env node
/**
 * Daily Brain — content generator.
 * Produces a payload with: quote, EPPP MCQ, validated PubMed study (PsyD-level breakdown).
 *
 * As a library: `import { generateToday } from "./generate-daily.js"` → returns payload object.
 * As a CLI: `node daily-dashboard/generate-daily.js [--force]` → writes today.json.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "today.json");

const today = new Date().toISOString().slice(0, 10);

const FEEDS = [
  { name: "PsyPost", url: "https://www.psypost.org/feed/" },
  { name: "Neuroscience News", url: "https://neurosciencenews.com/feed/" },
  { name: "ScienceDaily Mind & Brain", url: "https://www.sciencedaily.com/rss/mind_brain.xml" },
];
const MAX_AGE_DAYS = 14;

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function stripCdata(s) {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function pickTag(item, tag) {
  const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return "";
  return decodeEntities(stripCdata(m[1].trim()));
}

async function fetchFeed(feed) {
  const items = [];
  try {
    const r = await fetch(feed.url, { headers: { "User-Agent": "daily-brain/1.0" } });
    if (!r.ok) {
      console.warn("rss fetch", feed.name, "HTTP", r.status);
      return items;
    }
    const xml = await r.text();
    const itemMatches = xml.match(/<item[\s\S]*?<\/item>/g) || [];
    for (const raw of itemMatches) {
      const title = pickTag(raw, "title");
      const link = pickTag(raw, "link");
      const description = stripTags(pickTag(raw, "description"));
      const pubDate = pickTag(raw, "pubDate");
      if (!title || !link) continue;
      const date = pubDate ? new Date(pubDate) : null;
      const ageDays = date ? (Date.now() - date.getTime()) / 86400000 : 999;
      items.push({
        title,
        link,
        description: description.slice(0, 1500),
        pubDate: date ? date.toISOString() : null,
        ageDays,
        source: feed.name,
      });
    }
  } catch (e) {
    console.warn("rss fetch failed for", feed.name, e.message);
  }
  return items;
}

async function fetchTrendingCandidates() {
  const all = [];
  for (const feed of FEEDS) {
    const items = await fetchFeed(feed);
    all.push(...items);
  }
  const fresh = all.filter(i => i.ageDays <= MAX_AGE_DAYS);
  fresh.sort((a, b) => a.ageDays - b.ageDays);
  const bySource = {};
  for (const i of fresh) (bySource[i.source] ||= []).push(i);
  const interleaved = [];
  let added = true;
  while (added) {
    added = false;
    for (const src of Object.keys(bySource)) {
      if (bySource[src].length) {
        interleaved.push(bySource[src].shift());
        added = true;
      }
    }
  }
  return interleaved.slice(0, 12);
}

function extractKeyTerms(redditTitle) {
  // Strip clickbait prefixes and common filler words; keep likely study-content words.
  let t = redditTitle
    .replace(/^(new|study|research|scientists|researchers|finds?|shows?|reveals?|suggests?|claims?)[: ]+/i, "")
    .replace(/[“”"',.!?():;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stop = new Set("a an the of to and or but for in on at by with from is was are were be been being have has had this that these those it its as than then so we they you i your our".split(" "));
  const words = t.split(" ").filter(w => w.length > 2 && !stop.has(w.toLowerCase()));
  return words.slice(0, 8).join(" ");
}

async function pubmedSearch(query) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=${encodeURIComponent(query)}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return j.esearchresult?.idlist || [];
}

async function pubmedSummary(pmid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const s = j.result?.[pmid];
  if (!s) return null;
  const authors = (s.authors || []).slice(0, 4).map(a => a.name).join(", ") + (s.authors?.length > 4 ? ", et al." : "");
  const year = (s.pubdate || "").slice(0, 4);
  const doi = (s.articleids || []).find(x => x.idtype === "doi")?.value || null;
  return {
    pmid,
    title: s.title || "",
    authors: authors + (year ? ` (${year})` : ""),
    journal: s.fulljournalname || s.source || "",
    doi,
    studyUrl: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

async function pubmedAbstract(pmid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
  const r = await fetch(url);
  if (!r.ok) return "";
  return await r.text();
}

async function findValidatedStudy(candidates) {
  for (const c of candidates.slice(0, 10)) {
    // Build query from title plus any noun-ish tokens from description.
    const titleQuery = extractKeyTerms(c.title);
    const descQuery = extractKeyTerms(c.description || "").split(" ").slice(0, 4).join(" ");
    const queries = [titleQuery, `${titleQuery} ${descQuery}`.trim()].filter(Boolean);
    let matched = false;
    for (const query of queries) {
      try {
        const ids = await pubmedSearch(query);
        for (const pmid of ids) {
          const summary = await pubmedSummary(pmid);
          if (!summary || !summary.title) continue;
          const titleWords = new Set(summary.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
          const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
          const overlap = queryWords.filter(w => titleWords.has(w)).length;
          if (overlap < 2) continue;
          const abstract = await pubmedAbstract(pmid);
          return {
            ...summary,
            abstract,
            sourcePost: c,
            validated: true,
            validationNote: `Verified via PubMed (PMID ${pmid})`,
          };
        }
      } catch (e) {
        console.warn("pubmed lookup failed for", c.title.slice(0, 60), e.message);
      }
      if (matched) break;
    }
  }
  // Fallback: most recent blog summary, unverified but still a real journalist-curated article.
  if (candidates[0]) {
    const c = candidates[0];
    return {
      title: c.title,
      authors: "",
      journal: c.source,
      studyUrl: c.link,
      doi: null,
      abstract: c.description,
      sourcePost: c,
      validated: false,
      validationNote: "Source article from " + c.source + " — primary paper not independently matched on PubMed",
    };
  }
  return null;
}

const client = new Anthropic();

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    quote: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" }, author: { type: "string" } },
      required: ["text", "author"],
    },
    eppp: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        correctIndex: { type: "integer" },
        eli5: { type: "string" },
        whyOthersWrong: { type: "array", items: { type: "string" } },
      },
      required: ["question", "options", "correctIndex", "eli5", "whyOthersWrong"],
    },
    studyAnalysis: {
      type: "object",
      additionalProperties: false,
      properties: {
        eli5: { type: "string" },
        psydAnalysis: { type: "string" },
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
      },
      required: ["eli5", "psydAnalysis", "strengths", "weaknesses"],
    },
  },
  required: ["quote", "eppp", "studyAnalysis"],
};

async function generateContent(study) {
  const studyContext = study.validated
    ? `VERIFIED study from PubMed:
Title: ${study.title}
Authors: ${study.authors}
Journal: ${study.journal}
DOI: ${study.doi || "—"}
Abstract:
${(study.abstract || "").slice(0, 4000)}`
    : `UNVERIFIED — science-journalism summary from ${study.journal} (the primary paper could not be cleanly matched on PubMed):
Title: ${study.title}
Article URL: ${study.studyUrl}
Article summary text:
${(study.abstract || "").slice(0, 2000)}`;

  const prompt = `Today is ${today}. Generate fresh daily content for a psychology/neuropsychology dashboard targeted at PsyD students. Return ALL THREE pieces.

1) QUOTE: One real quote from a real psychologist, neuroscientist, philosopher, or scientist. VARY DAILY — do NOT default to William James, Carl Jung, or Viktor Frankl. Just text + author. NO explanation needed.

2) EPPP MULTIPLE-CHOICE: One question for the Examination for Professional Practice in Psychology. Cover any major content area (assessment, ethics, treatment, psychopathology, biological bases, lifespan, social/cultural, research methods, professional issues). 4 options. correctIndex 0-3. eli5 explanation of WHY the correct answer is correct (simple words, concrete imagery a 5yo could picture). whyOthersWrong: array of 4 strings — the entry at correctIndex must be exactly "(correct)", the other three give ELI5-style explanations of why each is wrong.

3) STUDY ANALYSIS for a PsyD student. Use simple, ELI5-level language throughout — short sentences, concrete imagery, no jargon dump — but with depth a clinical doctoral student needs. Provide:
   - eli5: 3-4 plain sentences. What did they do, what did they find. No clinical advice.
   - psydAnalysis: 4-6 sentences. Why does this matter for clinical psych practice? What's the methodology in plain terms? What population/setting? What can a future clinician do with this?
   - strengths: 3-5 short bullets (each one sentence). Things like sample size, design quality, replication, ecological validity.
   - weaknesses: 3-5 short bullets (each one sentence). Limitations: small N, selection bias, generalizability, confounds, replication concerns, etc.
   ${study.validated
     ? "Ground all analysis in the abstract provided. Do not invent details not in the abstract."
     : "The primary paper could NOT be matched on PubMed, but the source IS a legitimate science-journalism summary. Note in psydAnalysis that you're working from the journalist's summary rather than the original abstract. Base strengths/weaknesses on what's described in the article. Do NOT invent specific N values, p-values, or methods that the article doesn't mention."}

${studyContext}

Ethics: no diagnostic claims, no medication advice, no clinical promises. Return JSON matching the schema exactly.`;

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    output_config: {
      format: { type: "json_schema", schema: SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  return JSON.parse(textBlock.text);
}

export async function generateToday() {
  console.log("[daily-brain]", today, "— generating content");

  console.log("→ fetching trending psych studies from RSS feeds");
  const candidates = await fetchTrendingCandidates();
  if (candidates.length === 0) {
    throw new Error("No trending study candidates found");
  }
  console.log("  ", candidates.length, "candidates from", FEEDS.map(f => f.name).join(", "));

  console.log("→ validating top candidates against PubMed");
  const study = await findValidatedStudy(candidates);
  if (!study) throw new Error("No usable study found");
  console.log("  picked:", study.title.slice(0, 80));
  console.log("  validated:", study.validated, "—", study.validationNote);

  console.log("→ asking Claude for quote + EPPP + study analysis");
  const generated = await generateContent(study);

  return {
    date: today,
    generatedAt: new Date().toISOString(),
    quote: generated.quote,
    eppp: generated.eppp,
    study: {
      title: study.title,
      authors: study.authors || "",
      journal: study.journal || "",
      studyUrl: study.studyUrl,
      sourceUrl: study.sourcePost?.link || null,
      sourceName: study.sourcePost?.source || null,
      eli5: generated.studyAnalysis.eli5,
      psydAnalysis: generated.studyAnalysis.psydAnalysis,
      strengths: generated.studyAnalysis.strengths,
      weaknesses: generated.studyAnalysis.weaknesses,
      validated: study.validated,
      validationNote: study.validationNote,
    },
  };
}

const isCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const force = process.argv.includes("--force");
  if (!force && fs.existsSync(OUT)) {
    const existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (existing.date === today) {
      console.log("today.json already up to date for", today, "— skip (use --force to regenerate)");
      process.exit(0);
    }
  }
  generateToday()
    .then((payload) => {
      fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
      console.log("✓ wrote", OUT);
    })
    .catch((err) => {
      console.error("FAILED:", err);
      process.exit(1);
    });
}
