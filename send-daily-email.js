#!/usr/bin/env node
/**
 * Daily Brain — email sender.
 * Generates today's payload and emails it via Resend.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY — required (read by @anthropic-ai/sdk)
 *   RESEND_API_KEY    — required
 *   EMAIL_TO          — optional, defaults to diamond.ted@yahoo.com
 *   EMAIL_FROM        — optional, defaults to "Daily Brain <onboarding@resend.dev>"
 */

import "dotenv/config";
import { Resend } from "resend";
import { generateToday } from "./generate-daily.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  console.error("RESEND_API_KEY env var is required");
  process.exit(1);
}

const TO = process.env.EMAIL_TO || "diamond.ted@yahoo.com";
const FROM = process.env.EMAIL_FROM || "Daily Brain <onboarding@resend.dev>";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const OPTION_LETTERS = ["A", "B", "C", "D"];

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(yyyymmdd) {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function card(inner) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6e2d6;border-radius:12px;margin:0 0 20px 0;">
    <tr><td style="padding:24px;">${inner}</td></tr>
  </table>`;
}

function sectionLabel(text, color = "#a07a3a") {
  return `<div style="font:600 11px/1 ${FONT};color:${color};letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px 0;">${escapeHtml(text)}</div>`;
}

function renderQuote(q) {
  return card(`
    ${sectionLabel("Quote")}
    <div style="font:italic 18px/1.55 Georgia,serif;color:#1a1a1a;margin:0 0 12px 0;">&ldquo;${escapeHtml(q.text)}&rdquo;</div>
    <div style="font:14px/1 ${FONT};color:#666;">&mdash; ${escapeHtml(q.author)}</div>
  `);
}

function renderEppp(e) {
  const optionsHtml = e.options
    .map(
      (opt, i) => `
      <tr>
        <td style="padding:6px 10px 6px 0;vertical-align:top;font:600 14px/1.5 ${FONT};color:#444;width:20px;">${OPTION_LETTERS[i]}.</td>
        <td style="padding:6px 0;vertical-align:top;font:14px/1.55 ${FONT};color:#222;">${escapeHtml(opt)}</td>
      </tr>`
    )
    .join("");

  const explanationsHtml = e.whyOthersWrong
    .map((why, i) => {
      const isCorrect = i === e.correctIndex;
      const color = isCorrect ? "#2d7a3b" : "#666";
      const label = isCorrect ? "Correct" : escapeHtml(why);
      const weight = isCorrect ? "700" : "400";
      return `
        <tr>
          <td style="padding:5px 10px 5px 0;vertical-align:top;font:600 13px/1.5 ${FONT};color:${color};width:20px;">${OPTION_LETTERS[i]}.</td>
          <td style="padding:5px 0;vertical-align:top;font:${weight} 13px/1.55 ${FONT};color:${color};">${label}</td>
        </tr>`;
    })
    .join("");

  return card(`
    ${sectionLabel("EPPP — try first")}
    <div style="font:600 16px/1.5 ${FONT};color:#1a1a1a;margin:0 0 14px 0;">${escapeHtml(e.question)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">${optionsHtml}</table>

    <div style="margin:24px 0 18px 0;border-top:1px dashed #d8d2c2;padding-top:18px;">
      ${sectionLabel("Answer", "#2d7a3b")}
      <div style="font:600 14px/1.5 ${FONT};color:#2d7a3b;margin:0 0 12px 0;">${OPTION_LETTERS[e.correctIndex]} &mdash; ${escapeHtml(e.options[e.correctIndex])}</div>
      <div style="font:14px/1.6 ${FONT};color:#333;margin:0 0 16px 0;">${escapeHtml(e.eli5)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">${explanationsHtml}</table>
    </div>
  `);
}

function renderStudy(s) {
  const strengthsHtml = (s.strengths || [])
    .map((x) => `<li style="margin:6px 0;font:14px/1.55 ${FONT};color:#333;">${escapeHtml(x)}</li>`)
    .join("");
  const weaknessesHtml = (s.weaknesses || [])
    .map((x) => `<li style="margin:6px 0;font:14px/1.55 ${FONT};color:#333;">${escapeHtml(x)}</li>`)
    .join("");

  const badge = s.validated
    ? `<span style="display:inline-block;padding:3px 10px;background:#e8f5ec;color:#2d7a3b;font:700 10px/1.4 ${FONT};border-radius:10px;letter-spacing:1px;text-transform:uppercase;">PubMed verified</span>`
    : `<span style="display:inline-block;padding:3px 10px;background:#fff3e0;color:#a05a00;font:700 10px/1.4 ${FONT};border-radius:10px;letter-spacing:1px;text-transform:uppercase;">Journalist summary</span>`;

  const authorsLine = s.authors ? `<div style="font:13px/1.5 ${FONT};color:#666;margin:4px 0 0 0;">${escapeHtml(s.authors)}</div>` : "";
  const journalLine = s.journal ? `<div style="font:13px/1.5 ${FONT};color:#888;margin:2px 0 0 0;">${escapeHtml(s.journal)}</div>` : "";

  const sourceLinkHtml = s.sourceUrl
    ? `<a href="${escapeHtml(s.sourceUrl)}" style="color:#a07a3a;text-decoration:none;border-bottom:1px solid #d8c89a;">${escapeHtml(s.sourceName || "Source article")}</a>`
    : "";
  const studyLinkHtml = s.studyUrl
    ? `<a href="${escapeHtml(s.studyUrl)}" style="color:#a07a3a;text-decoration:none;border-bottom:1px solid #d8c89a;">Primary source</a>`
    : "";
  const linksLine = [studyLinkHtml, sourceLinkHtml].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");

  return card(`
    ${sectionLabel("Study of the day")}
    <div style="margin:0 0 8px 0;">${badge}</div>
    <div style="font:700 17px/1.4 ${FONT};color:#1a1a1a;margin:0 0 4px 0;">${escapeHtml(s.title)}</div>
    ${authorsLine}
    ${journalLine}

    <div style="margin:18px 0 0 0;">
      ${sectionLabel("In plain English")}
      <div style="font:14px/1.65 ${FONT};color:#333;">${escapeHtml(s.eli5)}</div>
    </div>

    <div style="margin:20px 0 0 0;">
      ${sectionLabel("Why it matters for clinical practice")}
      <div style="font:14px/1.65 ${FONT};color:#333;">${escapeHtml(s.psydAnalysis)}</div>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 0 0;">
      <tr>
        <td valign="top" style="width:50%;padding:0 10px 0 0;">
          ${sectionLabel("Strengths", "#2d7a3b")}
          <ul style="margin:0;padding:0 0 0 18px;">${strengthsHtml}</ul>
        </td>
        <td valign="top" style="width:50%;padding:0 0 0 10px;">
          ${sectionLabel("Weaknesses", "#a83a3a")}
          <ul style="margin:0;padding:0 0 0 18px;">${weaknessesHtml}</ul>
        </td>
      </tr>
    </table>

    ${linksLine ? `<div style="margin:20px 0 0 0;padding-top:14px;border-top:1px solid #efebe0;font:13px/1.5 ${FONT};color:#666;">${linksLine}</div>` : ""}
    ${s.validationNote ? `<div style="margin:8px 0 0 0;font:12px/1.4 ${FONT};color:#999;">${escapeHtml(s.validationNote)}</div>` : ""}
  `);
}

function renderEmail(p) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Daily Brain &mdash; ${escapeHtml(p.date)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ea;">
    <tr><td align="center" style="padding:28px 14px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr><td style="padding:0 4px 20px 4px;">
          <div style="font:800 24px/1 ${FONT};color:#1a1a1a;letter-spacing:-0.5px;">Daily Brain</div>
          <div style="margin-top:6px;font:13px/1 ${FONT};color:#888;letter-spacing:0.3px;">${escapeHtml(formatDate(p.date))}</div>
        </td></tr>
        <tr><td>${renderQuote(p.quote)}</td></tr>
        <tr><td>${renderEppp(p.eppp)}</td></tr>
        <tr><td>${renderStudy(p.study)}</td></tr>
        <tr><td style="padding:8px 4px 0 4px;font:12px/1.5 ${FONT};color:#aaa;">
          Generated ${escapeHtml(p.generatedAt)} &middot; Not clinical advice.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function main() {
  const payload = await generateToday();
  const html = renderEmail(payload);
  const subject = `Daily Brain — ${formatDate(payload.date)}`;

  const resend = new Resend(RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: [TO],
    subject,
    html,
  });
  if (error) {
    console.error("Resend error:", error);
    process.exit(1);
  }
  console.log("✓ sent to", TO, "— id:", data?.id);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
