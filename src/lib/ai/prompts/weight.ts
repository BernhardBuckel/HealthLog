import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { withOutputLanguage } from "./output-language";
import { instructionLocale } from "./output-language";
import {
  applyDisplayTransform,
  DEFAULT_UNIT_PREFERENCE,
  getDisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";

function weightSectionDe(q: (kg: number) => string): string {
  return `METRIK — GEWICHT:
- Der Snapshot trägt weight.signal (der fertige Vergleich) + weight.summary + weight.series (graded). weight.latestDayFocus zeigt den jüngsten Tageswert, den Schritt zum vorherigen Messtag und ggf. den Blutdruck desselben Tages.
- Fokus dieser Karte ist der kontinuierliche TREND und das TEMPO über die Zeit (Tempo pro Woche, Plateaus, Meilensteine), nicht die WHO-Band-Einordnung — die trägt die BMI-Karte. Den BMI-Wert nur als Nebenbezug nennen, nie das Band als zentrale Aussage hier.
- Wochen-/Monatstrend zählt, nicht der Einzelwert: Führe mit weight.signal — current, delta gegenüber baselineLabel und outsideNormalSwing sind bereits berechnet. NENNE sie, rechne sie NICHT neu. Tageschwankungen von ${q(1)}-${q(2)} (Wasser, Tageszeit) sind normal und kein Befund.
- Eigenes Ziel: Trägt der Snapshot weight.target, ist das der Zielbereich, den die Person selbst gesetzt hat; weight.target.progress sagt, welche Richtung Fortschritt ist (gaining = zunehmen, losing = abnehmen, holding steady = halten). Beurteile jede Veränderung GEGEN dieses Ziel: Liegt die Person darunter, ist eine Zunahme Fortschritt und nie ein Rückschritt. Die Hinweise zu Tempo und Meilensteinen beim Abnehmen unten gelten nur, wenn Abnehmen die Fortschrittsrichtung ist oder kein Ziel vorliegt.
- Plateau: Verändert sich das Mittel über > ~2 Wochen um < ${q(0.5)}, ist das ein Plateau — bei einem Abnehmenden ehrlich benennen, ohne zu entmutigen.
- Tempo: Nachhaltiger Verlust liegt bei ~${q(0.5)}-${q(1)} pro Woche (DGE). Anhaltend > ${q(1)} pro Woche ist eher Wasser/Muskel als Fett — vorsichtig einordnen.
- Meilensteine gegen das eigene Maximum: ~5 % Verlust vom höchsten Wert (series-Max) bringt bereits metabolischen Nutzen, ~10 % einen deutlichen — wenn erreicht, ausdrücklich anerkennen.
- BMI-Bezug nur als knapper Nebensatz, wenn die Größe im Profil vorliegt (sonst nicht behaupten); die WHO-Band-Einordnung selbst gehört auf die BMI-Karte, nicht hierher.
- Zusammenhänge: weightVsSystolic.correlation / weightVsMeanBloodPressure.correlation und moodContext.moodVsWeightCorrelation nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache.
- Eine Botschaft: Schließe NUR DANN mit EINEM machbaren Schritt, wenn der Befund einen nahelegt (z.B. bei einem Plateau zur selben Tageszeit wiegen, um den echten Trend zu sehen, statt am Tagesrauschen zu hängen). Ist der Trend stabil und gibt es nichts Sinnvolles zu tun, erkenne das ehrlich an und nenne stattdessen einen Punkt, den man im Auge behalten kann, statt einen Schritt zu erzwingen.`;
}

function weightSectionEn(q: (kg: number) => string): string {
  return `METRIC — WEIGHT:
- The snapshot carries weight.signal (the finished comparison) + weight.summary + weight.series (graded). weight.latestDayFocus shows the latest daily value, the step from the previous measured day and, where present, the same-day blood pressure.
- This card's focus is the continuous TREND and PACE over time (pace per week, plateaus, milestones), not WHO-band placement — the BMI card carries that. Mention the BMI value only as a side reference, never make the band the central message here.
- The weekly/monthly trend matters, not the single value: lead from weight.signal — current, delta vs baselineLabel and outsideNormalSwing are already computed. STATE them, do NOT recompute. Day-to-day swings of ${q(1)}-${q(2)} (water, time of day) are normal and not a finding.
- Own target: when the snapshot carries weight.target, that is the target band the person set themselves, and weight.target.progress says which way is progress (gaining, losing, or holding steady). Judge every change AGAINST that target: below it, a gain is progress and never a setback or a regression. The loss pace and milestone guidance below applies only when losing is the progress direction or no target is set.
- Plateau: if the mean moves < ${q(0.5)} over > ~2 weeks, that is a plateau — name it honestly for someone who is losing, without discouraging.
- Pace: sustainable loss is ~${q(0.5)}-${q(1)} per week (DGE). Sustained > ${q(1)} per week is more likely water/muscle than fat — frame cautiously.
- Milestones against their own maximum: ~5% loss from the highest value (series max) already brings metabolic benefit, ~10% a substantial one — acknowledge explicitly when reached.
- BMI reference only as a brief aside when height is in the profile (do not claim it otherwise); the WHO-band placement itself belongs on the BMI card, not here.
- Associations: mention weightVsSystolic.correlation / weightVsMeanBloodPressure.correlation and moodContext.moodVsWeightCorrelation only when present and |r| > 0.4 — as an association, never a cause.
- One message: close with ONE doable step that fits the direction ONLY when the finding implies one (e.g. on a plateau, weigh at the same time of day to see the real trend rather than the daily noise). When the trend is steady and there is nothing useful to do, affirm it honestly and name one thing worth keeping an eye on instead of manufacturing a step.`;
}

export function getWeightSystemPrompt(
  locale: Locale,
  /**
   * The reader's metric/imperial choice. The snapshot is in that unit, so
   * the swing, plateau and pace thresholds are stated in it too.
   */
  system: UnitPreference = DEFAULT_UNIT_PREFERENCE,
): string {
  const mass = getDisplayTransform("WEIGHT", system);
  const q = (kg: number) =>
    `${applyDisplayTransform(kg, mass)} ${mass.displayUnit}`;
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their
  // language and appends their own directive); only de takes the German one.
  const section =
    instructionLocale(locale) === "en"
      ? weightSectionEn(q)
      : weightSectionDe(q);
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}`,
    locale,
  );
}

export function getWeightUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
  /** v1.12.7 — diversity / anti-repetition context; see blood-pressure.ts. */
  assessmentContextBlock?: string,
  /** v1.28.40 — rotating opener-archetype hint; see metric-archetypes.ts. */
  openerHint?: string,
): string {
  const ctxBlock =
    previousContextBlock && previousContextBlock.trim().length > 0
      ? `\n\n${previousContextBlock}\n`
      : "";
  const extraBlock =
    assessmentContextBlock && assessmentContextBlock.trim().length > 0
      ? `\n\n${assessmentContextBlock}\n`
      : "";
  const openerLine =
    openerHint && openerHint.trim().length > 0
      ? `\nOPENER HINT: ${openerHint}`
      : "";
  if (instructionLocale(locale) === "en") {
    return `Date: ${todayKey}${openerLine}
Write one short assessment of this person's weight. Open with what the trend MEANS in plain words — the direction and momentum, not the number (e.g. "easing down steadily", "holding right where it's settled") — then bring in ONE concrete number from the snapshot right after as support, read as a continuous trend and pace against their own weekly/monthly baseline (pace per week, plateau, milestone — not the single value, and not the WHO band, which the BMI card covers); never lead with the value. Close with one doable step only when the finding genuinely implies one; when nothing is, skip the step rather than manufacture filler. Judge confidence from the measurement count and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Einschätzung zum Gewicht dieser Person. Beginne mit der BEDEUTUNG in klaren Worten — Richtung und Tempo, nicht der Zahl (z. B. "geht ruhig nach unten", "hält sich genau da, wo es sich eingependelt hat") — und bring danach EINE konkrete Zahl aus dem Snapshot als Beleg, als kontinuierlichen Trend und Tempo gegen die eigene Wochen-/Monats-Baseline gelesen (Tempo pro Woche, Plateau, Meilenstein — nicht der Einzelwert und nicht das WHO-Band, das die BMI-Karte trägt); führe nie mit dem Wert. Schließe nur dann mit einem machbaren Schritt, wenn der Befund wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
