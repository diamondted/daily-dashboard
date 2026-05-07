#!/usr/bin/env node
/**
 * Daily Brain — content generator.
 * Produces today.json with: quote, EPPP MCQ, validated PubMed study (PsyD-level breakdown).
 *
 * Run: node daily-dashboard/generate-daily.js
 *   --force     ignore that today.json already exists
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "today.json");

const FORCE = process.argv.includes("--force");
const today = new Date().toISOString().slice(0, 10);

if (!FORCE && fs.existsSync(OUT)) {
  const existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
  if (existing.date === today) {
    console.log("today.json already up to date for", today, "— skip (use --force to regenerate)");
    process.exit(0);
  }
}

const SUBREDDITS = ["neuro", "neuroscience", "cogsci", "cogneuro", "psychology"];
const STUDY_RX = /study|research|paper|finding|published|journal|trial|preprint|biorxiv|nature|science|neuron|cell|nih|pubmed|meta-analysis/i;

async function fetchTrendingCandidates() {
  const candidates = [];
  for (const sub of SUBREDDITS) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/top.json?t=week&limit=25`, {
        headers: { "User-Agent": "daily-brain/1.0" },
      });
      if (!r.ok) continue;
      const j = await r.json();
      for (const post of j.data.children) {
        const p = post.data;
        if (p.stickied || p.over_18) continue;
        if (!STUDY_RX.test(p.title + " " + (p.selftext || ""))) continue;
        candidates.push({
          title: p.title,
          subreddit: "r/" + p.subreddit,
          permalink: "https://reddit.com" + p.permalink,
          externalUrl: p.url_overridden_by_dest || null,
          selftext: (p.selftext || "").slice(0, 1500),
          score: p.score,
          comments: p.num_comments,
          rank: p.score + 2 * p.num_comments,
        });
      }
    } catch (e) {
      console.warn("reddit fetch failed for", sub, e.message);
    }
  }
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates;
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
  // Walk down the candidate list, try to validate each on PubMed.
  for (const c of candidates.slice(0, 8)) {
    const query = extractKeyTerms(c.title);
    if (!query) continue;
    try {
      const ids = await pubmedSearch(query);
      for (const pmid of ids) {
        const summary = await pubmedSummary(pmid);
        if (!summary || !summary.title) continue;
        // Sanity-check title overlap (avoid wrong-paper matches).
        const titleWords = new Set(summary.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
        const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const overlap = queryWords.filter(w => titleWords.has(w)).length;
        if (overlap < 2) continue;
        const abstract = await pubmedAbstract(pmid);
        return {
          ...summary,
          abstract,
          redditPost: c,
          validated: true,
          validationNote: `Verified via PubMed (PMID ${pmid})`,
        };
      }
    } catch (e) {
      console.warn("pubmed lookup failed for", c.title.slice(0, 60), e.message);
    }
  }
  // Fallback: return first candidate without validation.
  if (candidates[0]) {
    return {
      title: candidates[0].title,
      authors: "",
      journal: candidates[0].subreddit,
      studyUrl: candidates[0].externalUrl || candidates[0].permalink,
      doi: null,
      abstract: candidates[0].selftext,
      redditPost: candidates[0],
      validated: false,
      validationNote: "Could not be independently verified on PubMed",
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
    : `UNVERIFIED reddit-sourced post (PubMed match not found):
Title: ${study.title}
Source: ${study.journal}
Body text (may be a discussion thread, not a study):
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
     : "The source could NOT be verified on PubMed. Be honest about this — note in psydAnalysis that this is a discussion-level post or unverified claim, and base strengths/weaknesses on what's discernible from the post text only. Do NOT invent study methods or findings."}

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

async function main() {
  console.log("[daily-brain]", today, "— generating content");

  console.log("→ fetching trending psych studies from Reddit");
  const candidates = await fetchTrendingCandidates();
  if (candidates.length === 0) {
    throw new Error("No trending study candidates found");
  }
  console.log("  ", candidates.length, "candidates");

  console.log("→ validating top candidates against PubMed");
  const study = await findValidatedStudy(candidates);
  if (!study) throw new Error("No usable study found");
  console.log("  picked:", study.title.slice(0, 80));
  console.log("  validated:", study.validated, "—", study.validationNote);

  console.log("→ asking Claude for quote + EPPP + study analysis");
  const generated = await generateContent(study);

  const payload = {
    date: today,
    generatedAt: new Date().toISOString(),
    quote: generated.quote,
    eppp: generated.eppp,
    study: {
      title: study.title,
      authors: study.authors || "",
      journal: study.journal || "",
      studyUrl: study.studyUrl,
      redditUrl: study.redditPost?.permalink || null,
      eli5: generated.studyAnalysis.eli5,
      psydAnalysis: generated.studyAnalysis.psydAnalysis,
      strengths: generated.studyAnalysis.strengths,
      weaknesses: generated.studyAnalysis.weaknesses,
      validated: study.validated,
      validationNote: study.validationNote,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log("✓ wrote", OUT);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
