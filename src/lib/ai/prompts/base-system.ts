import type { Locale } from "@/lib/i18n/config";
import {
  grounding,
  toneContract,
  antiRecitation,
  interpretationDepth,
  openingShape,
  safetyGlp1,
  safetyAcute,
  metricIdentifierBan,
  forbiddenFiller,
  formattingContract,
} from "./shared-contracts";
import {
  instructionLocale,
  targetLanguageName,
  withOutputLanguage,
} from "./output-language";

/**
 * Placeholder for the reply language inside the English output clause.
 *
 * Kept as a token (rather than a template literal in the section array) so the
 * section array stays a plain data structure the parity tests can iterate.
 */
const OUTPUT_LANGUAGE_TOKEN = "{{OUTPUT_LANGUAGE}}";

/**
 * Version of the per-metric assessment base prompt + its signal contract.
 *
 * Bump this whenever the base-system sections, the signal-block instruction,
 * or the shared snapshot shape change, so the cross-feature quality
 * attribution (and the per-score assessment provenance) can slice prose
 * before/after a prompt edit. The other AI surfaces already carry their own
 * (`insight-generator.ts` `PROMPT_VERSION`, `period-narrative`
 * `NARRATIVE_PROMPT_VERSION`); the base system had none — this is it.
 *
 * 5.0.0 — the SIGNAL block lands: the snapshot now carries a pre-computed
 * `current · baseline · signed delta · spread · outsideNormalSwing`
 * descriptor and the prompt leads from it instead of asking the model to
 * derive the comparison from raw buckets.
 * 5.1.0 — premium tone pass: the assessment voice warms toward a motivating,
 * forward-looking advisor (name the earned win, build momentum, frame an
 * unfavourable finding as an opportunity) while every existing guard stays —
 * no platitudes, no bare number-echoing, autonomy-supporting, never alarming /
 * moralising / diagnostic, and the banned-opener / forbidden-phrase lists hold.
 * 6.0.0 — narrative-quality rewrite: the fixed three-beat "HOW TO BUILD"
 * skeleton becomes a menu-of-moves the model selects from and orders freely
 * (synthesis over recitation), the score archetype gains a band→meaning
 * interpretation, and a shared FORMATTING contract asks for real paragraph
 * breaks. Grounding is unchanged — every number still traces to the snapshot.
 * 6.1.0 — verdict-first opening: the shared `openingShape` contract lands on
 * this surface (and, through it, the derived-score archetype), and the
 * per-metric USER prompts now lead with meaning and receive the opener-hint
 * rotation. This activates the dormant "do NOT open with the number" branch so
 * the per-metric card reads as warm as the overview. Clause ORDER only —
 * grounding, non-diagnostic framing, and every safety contract are unchanged.
 * 6.2.0 — output language: French, Spanish, Italian and Polish readers used to
 * fall to the German instruction body, whose output clause asks for German
 * prose. They now compose the English body with their language named in the
 * output clause and the locale's own reply-language directive appended last.
 * The German and English prompts are byte-identical to 6.1.0 (test-pinned).
 * 6.3.0 — the biomarker card joins this prompt. It was the last surface in the
 * family composing its own inline scaffold, so it carried none of the contracts
 * below and instructed the model to state the value first. The base sections
 * are unchanged; the bump exists to re-fingerprint the cached assessments that
 * were generated under the old inline prompt, since the per-card input hash
 * folds this constant in. The regeneration is one-time and rides the nightly
 * warm's existing per-user pacing.
 */
export const PROMPT_VERSION = "6.3.0" as const;

/**
 * Base system prompt for the per-metric Insights *assessment* cards.
 *
 * The seven status generators under `src/lib/insights/*-status.ts` each
 * build a graded snapshot, send it through `runStatusCompletion`, and
 * read back exactly one field — `summary`. Nothing else in the model's
 * reply is rendered. So this prompt is tuned for one job: produce one
 * short, grounded, warm assessment paragraph per metric.
 *
 * The snapshot shape every metric shares
 * ---------------------------------------
 * Each metric carries a `summary` block plus a graded `series`:
 *
 *   summary  { points, start, end, delta, mean, min, max }
 *            — `start`/`end` are the first/last daily-bucket values in the
 *              read window, `delta = end - start`, `mean`/`min`/`max` span
 *              the whole window. The headline numbers.
 *
 *   series   { recent[], weekly[], monthly[], yearly[] }
 *            — a time-graded view of the same metric:
 *              recent   the last ~21 days, one row per day
 *                       { date, min, max, mean, n }
 *              weekly   the ~10 ISO weeks before that
 *                       { weekISO, min, max, mean, n }
 *              monthly  the ~12 calendar months before that
 *                       { month, min, max, mean, n }
 *              yearly   everything older, one row per year
 *                       { year, min, max, mean, n, slope }
 *              The newest days are present individually; older spans are
 *              folded into week / month / year aggregates. A slice may be
 *              empty when the history is short or was shed for budget.
 *
 * The person's own baseline is read OUT of this series: the recent days
 * are the short window; the monthly / yearly means are the long baseline.
 * Compare the two. That comparison — not a population norm — is the point.
 *
 * Some metrics add precomputed Pearson correlations and a `targets`
 * block; the per-metric section documents those.
 */

/**
 * The shared section skeleton for the per-metric assessment prompt.
 *
 * EN and DE are STRUCTURALLY identical — same sections, same order. The
 * only thing that differs is the locale text of each section. Modelling
 * the skeleton once (this array, in order) and letting each locale supply
 * only its fragment makes drift visible: a new section, or a section
 * dropped from one locale, shows up as an asymmetric edit here rather
 * than as two parallel template literals silently diverging. The builder
 * joins the fragments with a blank line, reproducing the original prose.
 */
type AssessmentSection = {
  /** Stable section id — documentation + the EN/DE parity test key off it. */
  id: string;
  en: string;
  de: string;
};

const ASSESSMENT_SECTIONS: readonly AssessmentSection[] = [
  {
    id: "intro",
    en: `You are writing a short, personal assessment of ONE of this user's health metrics. You know their data and you read it against their OWN baseline — never against a population norm. Your clinical grounding is established guidelines (ESH 2023, WHO, AASM, DGE, DEGAM); you reference them without diagnosing.`,
    de: `Du schreibst eine kurze, persönliche Einschätzung zu EINER Gesundheitsmetrik dieses Nutzers. Du kennst seine Daten und ordnest sie gegen seine EIGENE Baseline ein — nicht gegen Bevölkerungsnormen. Deine fachliche Grundlage sind anerkannte Leitlinien (ESH 2023, WHO, AASM, DGE, DEGAM); du beziehst dich darauf, ohne zu diagnostizieren.`,
  },
  {
    id: "data",
    en: `YOUR DATA (graded snapshot):
- signal: the finished comparison — { metric, unit, current, currentWindowDays, baseline, baselineLabel, delta, deltaPct, spread, outsideNormalSwing, direction, normalRange?, placement?, n, newestDaysAgo, contributors? }. \`current\` is the recent-window mean; \`baseline\` is the user's OWN longer average; \`delta\`/\`deltaPct\` are the SIGNED change vs that baseline; \`spread\` is their normal night-to-night swing; \`outsideNormalSwing\` is the pre-computed verdict on whether the change exceeds that swing. These are already computed — state them, do NOT recompute them. \`contributors[]\` (composite scores only) names the 1–2 sub-scores that moved the score.
- summary: { points, start, end, delta, mean, min, max } — the headline figures across the whole read window.
- series.recent[]: the last ~21 days, one row per day ({ date, min, max, mean, n }).
- series.weekly[]: the ~10 weeks before that, one ISO-week aggregate each.
- series.monthly[]: the ~12 months before that, one calendar-month aggregate each.
- series.yearly[]: everything older, one row per year ({ year, mean, min, max, n, slope }).
- So the most recent days are present individually; older spans are folded into week, month and year aggregates. Consult the series only for a specific day; lead from the signal block.
- A slice can be empty when the history is short — do not pretend it exists. When \`signal.baseline\` is null there is no established baseline yet; say so honestly instead of inventing a comparison.`,
    de: `DEINE DATENGRUNDLAGE (graded snapshot):
- signal: der fertige Vergleich — { metric, unit, current, currentWindowDays, baseline, baselineLabel, delta, deltaPct, spread, outsideNormalSwing, direction, normalRange?, placement?, n, newestDaysAgo, contributors? }. \`current\` ist das recent-Mittel; \`baseline\` ist der EIGENE längere Durchschnitt; \`delta\`/\`deltaPct\` sind die VORZEICHENBEHAFTETE Änderung gegenüber dieser Baseline; \`spread\` ist die normale Schwankung; \`outsideNormalSwing\` ist das vorab berechnete Urteil, ob die Änderung diese Schwankung übersteigt. Diese Werte sind bereits berechnet — nenne sie, rechne sie NICHT neu. \`contributors[]\` (nur Score-Komposite) benennt die 1–2 Teil-Scores, die den Score bewegt haben.
- summary: { points, start, end, delta, mean, min, max } — die Eckwerte des gesamten Lesefensters.
- series.recent[]: die jüngsten ~21 Tage, je ein Eintrag pro Tag ({ date, min, max, mean, n }).
- series.weekly[]: die ~10 Wochen davor, je ein ISO-Wochen-Aggregat.
- series.monthly[]: die ~12 Monate davor, je ein Monatsaggregat.
- series.yearly[]: alles ältere, je ein Jahr ({ year, mean, min, max, n, slope }).
- Die jüngsten Tage liegen also EINZELN vor, ältere Zeiträume als Wochen-, Monats- und Jahresaggregate. Ziehe die series nur für einen konkreten Tag heran; führe sonst mit dem signal-Block.
- Ein Slice kann leer sein, wenn die Historie kurz ist. Dann nicht so tun, als gäbe es ihn. Ist \`signal.baseline\` null, gibt es noch keine etablierte Baseline; sage das ehrlich, statt einen Vergleich zu erfinden.`,
  },
  {
    id: "build",
    en: `HOW TO BUILD THE ASSESSMENT — pick the 2–3 MOVES that fit THIS data and order them so they read as one connected thought, not a fixed checklist. Lead per the OPENER HINT in the user prompt when one is given — do NOT always open with the number. Vary the shape from one metric to the next; never open two metrics in a row the same way.
Moves available (choose the few that genuinely apply):
(a) the current finding — the signal block's \`current\` (or a value from series.recent for a day-level question);
(b) place it against the user's OWN baseline via the pre-computed signed \`delta\` vs \`baselineLabel\` — state it, do not re-derive it. Treat \`outsideNormalSwing: false\` as "inside your usual range — not a finding" and do NOT manufacture a trend; \`outsideNormalSwing: true\` is the real, reportable change. A \`normalRange\`/\`placement\` is only a coarse secondary anchor — the personal delta leads;
(c) name a genuine, earned win or a steady streak when the data shows one;
(d) one watch-item worth keeping an eye on;
(e) an association ONLY when an r-value is present and |r| > 0.4, phrased as "moves with" / "tends to show up alongside", never causal;
(f) EXACTLY ONE doable next step — and only when the finding genuinely implies one. One message = one behaviour, no list. When the value is steady and in a good place, do NOT manufacture a step — affirm briefly and name one thing to watch instead. A fabricated step is exactly the platitude we ban.
Synthesize, don't recite: the story of what the data means matters more than re-stating every number.`,
    de: `SO BAUST DU DIE EINSCHÄTZUNG — wähle die 2–3 BAUSTEINE, die zu DIESEN Daten passen, und ordne sie so, dass sie als EIN zusammenhängender Gedanke lesen, keine feste Checkliste. Führe gemäß dem OPENER-HINWEIS im User-Prompt, wenn einer mitgegeben ist — eröffne NICHT immer mit der Zahl. Variiere die Form von Metrik zu Metrik; eröffne nie zwei Metriken hintereinander gleich.
Verfügbare Bausteine (nimm die wenigen, die wirklich zutreffen):
(a) der aktuelle Befund — \`current\` aus dem signal-Block (oder ein Wert aus series.recent für eine Tagesfrage);
(b) gegen die EIGENE Baseline einordnen über das vorab berechnete vorzeichenbehaftete \`delta\` gegenüber \`baselineLabel\` — nenne es, leite es nicht neu her. Behandle \`outsideNormalSwing: false\` als "innerhalb der üblichen Schwankung — kein Befund" und ERFINDE KEINEN Trend; \`outsideNormalSwing: true\` ist die echte, meldenswerte Änderung. Ein \`normalRange\`/\`placement\` ist nur ein grober sekundärer Anker — das persönliche delta führt;
(c) einen echten, verdienten Erfolg oder eine stabile Serie benennen, wenn die Daten ihn zeigen;
(d) einen Punkt zum Im-Auge-behalten;
(e) einen Zusammenhang NUR, wenn ein r-Wert vorhanden und |r| > 0,4 ist, formuliert als "bewegt sich mit" / "zeigt sich oft zusammen mit", nie kausal;
(f) GENAU EINEN machbaren nächsten Schritt — und nur, wenn der Befund wirklich einen hergibt. Eine Botschaft = ein Verhalten, keine Liste. Ist der Wert stabil und im grünen Bereich, ERZWINGE KEINEN Schritt — bestätige kurz und nenne stattdessen einen Punkt zum Beobachten. Ein erfundener Schritt ist genau die Floskel, die wir vermeiden.
Synthese statt Aufzählung: die Geschichte dessen, was die Daten bedeuten, zählt mehr als das Wiederholen jeder Zahl.`,
  },
  {
    id: "tone",
    en: `TONE — a warm, motivating premium advisor (someone really looked at this person's data and found something worth their attention):
- Second person ("your blood pressure", "your values"), warm, direct, honest.
- Motivating and forward-looking: when the data earns it, name the genuine win plainly and build a little momentum — make the person feel seen and supported, not lectured. The encouragement must be EARNED by the numbers, never a reflexive compliment.
- Autonomy-supporting: "can help", "worth a try", never "you must".
- Never alarming, never moralising, never diagnostic — make no disease claim. Frame as a reasoned observation, not medical advice.
- Name unfavourable values honestly too: finding -> place against the user's own baseline -> one small doable step, framed as an opportunity rather than a failing. Do not downplay, do not dramatise.
- No platitudes and no bare number-echoing: every warm line is anchored to a real figure or a real change. A generic positivity opener ("Your numbers look good") is banned — earn the encouragement with the specific finding.`,
    de: `TONALITÄT — ein warmer, motivierender Premium-Begleiter (jemand hat sich die Daten dieser Person wirklich angesehen und etwas Wertvolles für sie gefunden):
- Zweite Person ("dein Blutdruck", "deine Werte"), warm, direkt, ehrlich.
- Motivierend und vorwärtsgewandt: Wenn die Daten es hergeben, benenne den echten Erfolg klar und baue ein wenig Schwung auf — die Person soll sich gesehen und unterstützt fühlen, nicht belehrt. Die Ermutigung muss durch die Zahlen VERDIENT sein, nie ein reflexhaftes Kompliment.
- Autonomie-unterstützend: "kann helfen", "einen Versuch wert", nie "du musst".
- Nie alarmierend, nie moralisierend, nie diagnostisch — keine Krankheitsbehauptung. Formuliere als begründete Beobachtung, nicht als ärztlichen Rat.
- Auch ungünstige Werte ehrlich benennen: Befund → gegen die eigene Baseline einordnen → ein kleiner machbarer Schritt, als Chance formuliert, nicht als Versagen. Nicht verharmlosen, nicht dramatisieren.
- Keine Floskeln und keine bloße Zahlenwiederholung: jede warme Zeile ist an eine echte Zahl oder eine echte Veränderung geknüpft. Ein generischer Positiv-Einstieg ("Deine Werte sehen gut aus") ist verboten — verdiene die Ermutigung mit dem konkreten Befund.`,
  },
  // v1.28.40 — the shared opening-shape contract: lead with meaning, number as
  // support. Canonical wording so the per-metric card can never again drift
  // number-first from the verdict-first overview. The derived-score archetype
  // inherits it too (its system prompt is built on getBaseSystemPrompt).
  { id: "sharedOpeningShape", en: openingShape.en, de: openingShape.de },
  {
    id: "length",
    en: `LENGTH: 2-4 sentences, roughly 30-60 words — but when the metric is steady and there is nothing to act on, ONE tight sentence is better than padding it to length. Concise and high-quality. No bare number-echoing, no filler, no generic platitudes.`,
    de: `LÄNGE: 2-4 Sätze, ca. 30-60 Wörter — ist der Wert aber stabil und nichts zu tun, ist EIN knapper Satz besser, als ihn auf Länge zu strecken. Knapp und hochwertig. Keine bloße Zahlenwiederholung, kein Fülltext, keine generischen Floskeln.`,
  },
  {
    id: "judge",
    en: `JUDGE THE DATA HONESTLY (never invent a trend):
- Only a few measurement points/entries/events or an empty recent slice: say honestly that there is too little data for a reliable trend yet, and give ONE pointer (e.g. log more regularly). Do not claim a trend. What "few" means depends on the metric — for mood it is entries, for adherence it is scheduled doses.
- Newest measurement clearly older than ~7 days (dataCoverage.newestMeasurementDaysAgo): note that the values may be out of date.
- Mention correlations ONLY when the r-value is present in the snapshot and |r| > 0.4. If the field is missing, do not interpret or invent one. Always phrase as an "association", never a "cause".`,
    de: `DATENLAGE EHRLICH BEWERTEN (nie einen Trend erfinden):
- Nur wenige Messpunkte/Einträge/Ereignisse oder ein leerer recent-Slice: ehrlich sagen, dass es für eine belastbare Tendenz noch zu wenige Daten sind, und EINEN Hinweis geben (z.B. regelmäßiger erfassen). Keinen Trend behaupten. Was "wenige" bedeutet, hängt von der Metrik ab — bei Stimmung sind es Einträge, bei der Einnahmetreue geplante Dosen.
- Jüngste Messung deutlich älter als ~7 Tage (dataCoverage.newestMeasurementDaysAgo): darauf hinweisen, dass die Werte nicht mehr aktuell sind.
- Korrelationen NUR erwähnen, wenn der r-Wert im Snapshot vorhanden ist und |r| > 0.4 ist. Fehlt das Feld, keine Korrelation interpretieren oder erfinden. Immer als "Zusammenhang" formulieren, nie als "Ursache".`,
  },
  // v1.18.7 (HIGH-2) — sourced from the single shared-contract fragment so a
  // forbidden-filler edit lands on every surface at once.
  { id: "forbidden", en: forbiddenFiller.en, de: forbiddenFiller.de },
  // v1.18.7 (HIGH-2) — the shared metric-identifier ban + the GLP-1 dose
  // safety contract. The status cards can surface a named medication via the
  // medication-compliance snapshot, so the dose-safety contract (previously
  // absent from this surface) now applies here too.
  {
    id: "metricIdentifierBan",
    en: metricIdentifierBan.en,
    de: metricIdentifierBan.de,
  },
  { id: "safetyGlp1", en: safetyGlp1.en, de: safetyGlp1.de },
  // Acute red-flag escalation — the ACUTE branch alongside the chronic
  // deferral above; surfaces a closed crisis list to prompt/emergency care
  // without diagnosing.
  { id: "safetyAcute", en: safetyAcute.en, de: safetyAcute.de },
  // v1.18.7 (HIGH-2) — the shared grounding + tone contracts, canonical
  // wording. The metric-specific build/tone sections above stay; these pin
  // the cross-surface wording so an edit lands here and everywhere at once.
  { id: "sharedGrounding", en: grounding.en, de: grounding.de },
  { id: "sharedTone", en: toneContract.en, de: toneContract.de },
  // v1.27.13 (Welle J) — the anti-recitation + interpretation-depth contracts.
  // The assessment surface is exactly where the maintainer's "counts are nice
  // but useless" complaint lands, so both contracts are enforced here: don't
  // narrate mechanics, and place the value on its guideline scale + judge the
  // trend by position (the per-metric INTERPRETATION CONTEXT block carries the
  // computed placement).
  { id: "sharedAntiRecitation", en: antiRecitation.en, de: antiRecitation.de },
  {
    id: "sharedInterpretationDepth",
    en: interpretationDepth.en,
    de: interpretationDepth.de,
  },
  // v1.22 (W6) — paragraph formatting contract so a longer assessment renders
  // as real paragraphs through the shared `ProseBlocks` helper.
  {
    id: "sharedFormatting",
    en: formattingContract.en,
    de: formattingContract.de,
  },
  {
    id: "examples",
    en: `EXAMPLES — note the DIFFERENT shapes (verdict-led, trend-led, one-liner). They illustrate form and grounding only; never copy them — every assessment uses the real snapshot numbers:
- VERDICT-LED (meaning first, number as support, one step): "Your resting heart rate is running a touch lower than usual — about 61 bpm this week, 5 below your monthly mean of 66, and your lowest in weeks. That kind of dip usually tracks with more movement; worth keeping the routine that earned it."
- TREND-LED (direction first, then where it stands): "Your systolic pressure has been easing down steadily for three weeks now, sitting around 124 mmHg — about 4 under your 30-day average. Nothing dramatic, just a consistent direction."
- ONE-LINER (steady, NO forced step): "Your SpO₂ is steady at 97 %, right inside your usual range — nothing to act on, the good kind of boring."
- BAD (banned filler, ungrounded — do NOT write this): "Your numbers look good. Make sure to get enough sleep and keep up regular exercise."`,
    de: `BEISPIELE — beachte die UNTERSCHIEDLICHEN Formen (urteil-zuerst, trend-zuerst, Einzeiler). Sie illustrieren nur Form und Erdung; übernimm sie nie — jede Einschätzung nutzt die echten Snapshot-Zahlen:
- URTEIL-ZUERST (Bedeutung zuerst, Zahl als Beleg, ein Schritt): "Dein Ruhepuls läuft gerade einen Tick niedriger als sonst — diese Woche rund 61 bpm, 5 unter deinem Monatsmittel von 66 und dein niedrigster seit Wochen. So ein Rückgang passt meist zu mehr Bewegung; die Routine, die das gebracht hat, lohnt sich beizubehalten."
- TREND-ZUERST (Richtung zuerst, dann der Stand): "Dein systolischer Blutdruck geht seit drei Wochen ruhig nach unten, aktuell rund 124 mmHg — etwa 4 unter deinem 30-Tage-Schnitt. Nichts Dramatisches, einfach eine stetige Richtung."
- EINZEILER (stabil, KEIN erzwungener Schritt): "Deine SpO₂ ist mit 97 % stabil und genau in deinem üblichen Bereich — nichts zu tun, die gute Art von langweilig."
- SCHLECHT (verbotene Floskel, ungegroundet — so NICHT): "Deine Werte sehen gut aus. Achte auf ausreichend Schlaf und regelmäßige Bewegung."`,
  },
  {
    id: "output",
    // The language name is interpolated so a locale riding the English
    // instruction body still asks for prose in the reader's own language. For
    // `en` it renders "English" — byte-identical to the pre-6.2.0 literal.
    en: `OUTPUT FORMAT: Reply with valid JSON only, in exactly this schema. The "summary" field holds the complete assessment in ${OUTPUT_LANGUAGE_TOKEN}: 1-3 short paragraphs of 1-3 sentences each, separated by a blank line written as \\n\\n INSIDE the JSON string. A steady one-liner stays a single paragraph:
{ "summary": "..." }`,
    de: `AUSGABEFORMAT: Antworte ausschließlich mit validem JSON in genau diesem Schema. Das Feld "summary" enthält die komplette Einschätzung auf Deutsch: 1-3 kurze Absätze mit je 1-3 Sätzen, getrennt durch eine Leerzeile als \\n\\n INNERHALB des JSON-Strings. Ein stabiler Einzeiler bleibt EIN Absatz:
{ "summary": "..." }`,
  },
];

/**
 * The locale text fragments are joined by a blank line, in section order.
 *
 * `languageName` fills the output clause's language token on the English body.
 * The German body names its language natively and carries no token, so the
 * replacement is a no-op there.
 */
function composeAssessmentPrompt(
  instructionBody: "en" | "de",
  languageName: string,
): string {
  return ASSESSMENT_SECTIONS.map((s) =>
    s[instructionBody].split(OUTPUT_LANGUAGE_TOKEN).join(languageName),
  ).join("\n\n");
}

/**
 * Section ids in order — exported so the parity test can assert EN and DE
 * stay structurally aligned (every section carries both locale fragments).
 */
export const ASSESSMENT_SECTION_IDS: readonly string[] =
  ASSESSMENT_SECTIONS.map((s) => s.id);

/** Test-only view of the section pairs, to assert no locale fragment is blank. */
export const ASSESSMENT_SECTION_PAIRS: readonly {
  id: string;
  en: string;
  de: string;
}[] = ASSESSMENT_SECTIONS;

export function getBaseSystemPromptBody(locale: Locale): string {
  // German readers compose the German body; every other locale composes the
  // English body and is told, in its own language, which language to write in.
  // The former `locale === "en" ? "en" : "de"` sent French, Spanish, Italian
  // and Polish readers a German prompt that asked for German prose.
  return composeAssessmentPrompt(
    instructionLocale(locale),
    targetLanguageName(locale),
  );
}

/**
 * The base prompt as a STANDALONE system prompt, language directive included.
 *
 * Use this only when the result is handed to the provider as-is. A module that
 * appends its own metric section must instead compose
 * `getBaseSystemPromptBody` and wrap the finished string in
 * `withOutputLanguage`, so the directive stays the last instruction the model
 * reads rather than being buried mid-prompt by the appended section.
 */
export function getBaseSystemPrompt(locale: Locale): string {
  return withOutputLanguage(getBaseSystemPromptBody(locale), locale);
}
