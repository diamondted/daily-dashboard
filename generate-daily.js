#!/usr/bin/env node
/**
 * Daily Brain — content generator.
 * Produces today.json with: quote, EPPP MCQ, trending study (all ELI5).
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

async function fetchTrendingStudy() {
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
        const looksLikeStudy =
          /study|research|paper|finding|published|journal|trial|preprint|biorxiv|nature|science|neuron|cell|nih|pubmed/i.test(
            p.title + " " + (p.selftext || "")
          );
        if (!looksLikeStudy) continue;
        candidates.push({
          title: p.title,
          subreddit: "r/" + p.subreddit,
          url: "https://reddit.com" + p.permalink,
          score: p.score,
          comments: p.num_comments,
          selftext: (p.selftext || "").slice(0, 1500),
          externalUrl: p.url_overridden_by_dest || null,
        });
      }
    } catch (e) {
      console.warn("reddit fetch failed for", sub, e.message);
    }
  }
  candidates.sort((a, b) => b.score + b.comments * 2 - (a.score + a.comments * 2));
  if (candidates.length === 0) {
    return {
      title: "(No trending study found today)",
      source: "—",
      url: "https://www.reddit.com/r/neuroscience/",
      selftext: "",
    };
  }
  const top = candidates[0];
  return {
    title: top.title,
    source: top.subreddit + ` · ${top.score} upvotes`,
    url: top.url,
    selftext: top.selftext,
    externalUrl: top.externalUrl,
  };
}

const client = new Anthropic();

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    quote: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        author: { type: "string" },
        eli5: { type: "string" },
      },
      required: ["text", "author", "eli5"],
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
    studyEli5: { type: "string" },
  },
  required: ["quote", "eppp", "studyEli5"],
};

async function generateContent(study) {
  const prompt = `Today is ${today}. Generate fresh daily content for a psychology/neuropsychology dashboard. Return ALL THREE pieces.

1) QUOTE: One inspiring or thought-provoking quote relevant to psychology, neuroscience, the mind, or human behavior. Real quote from a real person (psychologist, neuroscientist, philosopher, scientist, writer). Vary it day to day — do NOT default to William James, Carl Jung, or Viktor Frankl every time. Include a one-sentence ELI5 explanation of what it means for someone with no background.

2) EPPP QUESTION: One multiple-choice question for the Examination for Professional Practice in Psychology (EPPP). Cover any major content area: assessment, ethics, treatment, psychopathology, biological bases, social/cultural, lifespan, research methods, professional issues. Provide 4 options. Indicate correctIndex (0–3). Provide an ELI5 explanation of WHY the correct answer is correct, written like you're explaining to a 5-year-old (simple words, concrete examples). Provide a "whyOthersWrong" array of 4 strings (one per option, including the correct one — for the correct one just write "(correct)"). Each wrong-answer explanation should also be ELI5-friendly.

3) STUDY ELI5: Here is the trending study/post. Write a 3-4 sentence ELI5 summary of what it's about and why it matters. Avoid jargon. If you're not sure what the study is actually about (e.g. it's just a discussion thread), say so honestly and summarize the conversation instead.

STUDY:
Title: ${study.title}
Source: ${study.source}
${study.externalUrl ? "External link: " + study.externalUrl + "\n" : ""}Discussion text: ${study.selftext || "(no body text)"}

Return JSON matching the schema. Be accurate, ethical, and avoid clinical advice. ELI5 means: short sentences, no jargon, concrete imagery a child could picture.`;

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

  console.log("→ fetching trending study from Reddit");
  const study = await fetchTrendingStudy();
  console.log("  picked:", study.title.slice(0, 80));

  console.log("→ asking Claude for quote + EPPP + study ELI5");
  const generated = await generateContent(study);

  const payload = {
    date: today,
    generatedAt: new Date().toISOString(),
    quote: generated.quote,
    eppp: generated.eppp,
    study: {
      title: study.title,
      source: study.source,
      url: study.externalUrl || study.url,
      eli5: generated.studyEli5,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log("✓ wrote", OUT);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
