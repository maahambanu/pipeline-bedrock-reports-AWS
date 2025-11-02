import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const s3 = new S3Client({});
const ses = new SESClient({ region: process.env.SES_REGION || process.env.AWS_REGION });
const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });

const BUCKET = process.env.ARTIFACT_BUCKET;
const RECIPIENTS = (process.env.RECIPIENT_EMAILS || "").split(",").map(s=>s.trim()).filter(Boolean);
const SENDER = process.env.SENDER_EMAIL;
const SUBJECT_PREFIX = process.env.EMAIL_SUBJECT_PREFIX || "";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.titan-text-express-v1";

const log = (...a) => console.log(JSON.stringify({ level: "info", msg: a.join(" ") }));
const err = (...a) => console.error(JSON.stringify({ level: "error", msg: a.join(" ") }));

async function bodyToString(body) {
  if (!body) return "";
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body?.transformToString === "function") return body.transformToString();
  return new Promise((resolve, reject) => {
    const chunks = [];
    body.on("data", c => chunks.push(c));
    body.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    body.on("error", reject);
  });
}
const truncate = (s, max=60000) => s.length > max ? s.slice(0,max)+`\n...[truncated ${s.length-max} chars]` : s;
const runOf = key => (key.split("/").length >= 3 ? key.split("/")[1] : null);

async function listPrefixText(prefix) {
  const out = [];
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  log("Listed", String(list.KeyCount ?? (list.Contents?.length || 0)), "under", prefix);
  for (const obj of list.Contents || []) {
    if (!obj.Key) continue;
    const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    const text = truncate(await bodyToString(got.Body));
    out.push(`\n--- FILE: ${obj.Key} ---\n${text}`);
  }
  return out.join("\n");
}

function buildPrompt(allText) {
  return `
You are a CI quality assistant. Create a clear, executive-friendly report from the data below.

Include sections:
- Build/Test Overview
- Unit/Integration test summary (pass/fail counts, notable failing tests)
- Code quality issues from SonarQube (rule types, severities, hotspots)
- Trends or risks
- Action items for the team

Be concise and readable for email. If data is missing, state assumptions.

<RAW_CI_DATA>
${allText}
</RAW_CI_DATA>
`.trim();
}

async function sendEmail(subject, bodyText) {
  log("SES send", `to=${RECIPIENTS.join(",")}`, `from=${SENDER}`);
  const res = await ses.send(new SendEmailCommand({
    Source: SENDER,
    Destination: { ToAddresses: RECIPIENTS },
    Message: { Subject: { Data: subject }, Body: { Text: { Data: bodyText } } },
  }));
  log("SES result", JSON.stringify(res));
}

export const handler = async (event) => {
  log("Event", JSON.stringify(event).slice(0,1000));
  const recs = event?.Records || [];
  for (const rec of recs) {
    const msg = rec.Sns?.Message ? JSON.parse(rec.Sns.Message) : null;
    const s3Recs = msg?.Records || [];
    for (const r of s3Recs) {
      const key = decodeURIComponent(r.s3.object.key.replace(/\+/g, " "));
      const run = runOf(key);
      log("Processing", key, "run:", run);

      let collected = "";
      try {
        if (run) {
          const tests = await listPrefixText(`test-results/${run}/`);
          const sonar = await listPrefixText(`sonarqube/${run}/`);
          collected = [tests, sonar].filter(Boolean).join("\n");
        }
        if (!collected) {
          const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
          collected = `\n--- FILE: ${key} ---\n${truncate(await bodyToString(got.Body))}`;
        }
      } catch (e) { err("S3 read error", e?.message || e); }

      let report = "";
      try {
        const prompt = buildPrompt(collected || "(no CI data found)");
        const req = {
          inputText: prompt,
          textGenerationConfig: { maxTokenCount: 1500, temperature: 0.2, topP: 0.9, stopSequences: [] }
        };
        const resp = await bedrock.send(new InvokeModelCommand({
          modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(req)
        }));
        const decoded = JSON.parse(new TextDecoder().decode(resp.body));
        report = decoded?.results?.[0]?.outputText ?? "";
        log("Bedrock OK, chars:", String(report.length));
      } catch (e) {
        err("Bedrock error", e?.message || e);
        report = "Bedrock failed to generate a report.\n\n" + (collected || "(no CI data captured)");
      }

      const subject = `${SUBJECT_PREFIX ? SUBJECT_PREFIX + " " : ""}CI Report ${run ? `- ${run}` : ""}`.trim();
      try { await sendEmail(subject, report || "(empty report)"); }
      catch (e) { err("SES send error", e?.message || e); }
    }
  }
  return { ok: true };
};
